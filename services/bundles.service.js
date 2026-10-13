import { writeAudit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { containsPattern, runListQuery } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Bundle, BundleMember } from '../models/bundle.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { User } from '../models/user.model.js';

// Bundles: named lists of people and companies for bulk mail and bulk WhatsApp (docs/BULK.md).
//
//   - A member is a person of a company (a contact) or the company's own general address.
//     It keeps only ids: the name, the email and the phone are read from the contact or the
//     company when they are needed, so a correction there is used at the next sending.
//   - Only people and companies the actor may see can be put into a bundle.
//   - Who sees a bundle: its maker; beyond that the "campaigns" permission scope.

const FEATURE = 'campaigns';
const OWNERSHIP = { ownerField: 'createdBy' };
export const MAX_BUNDLE_MEMBERS = 2000;
const NOT_DELETED = { deletedAt: null };

const visibleTo = (actor) => scopeFilter(actor, FEATURE, OWNERSHIP);

export async function loadBundle(actor, bundleId) {
  const bundle = await Bundle.findOne({ $and: [{ _id: bundleId }, visibleTo(actor)] }).lean();
  if (!bundle) throw notFound('Bundle not found');
  return bundle;
}

const bundleView = (bundle, makers) => ({
  id: String(bundle._id),
  name: bundle.name,
  memberCount: bundle.memberCount,
  createdBy: makers?.get(String(bundle.createdBy)) ?? null,
  createdAt: bundle.createdAt,
});

/** @param {{ search?: string, page: number, pageSize: number }} query  Validated */
export async function listBundles(actor, query) {
  const { rows, pagination } = await runListQuery(Bundle, {
    filter: {
      $and: [visibleTo(actor), query.search ? { name: containsPattern(query.search) } : {}],
    },
    sort: { createdAt: -1, _id: -1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  const users = await User.find({ _id: { $in: rows.map((row) => row.createdBy) } })
    .select('name')
    .lean();
  const makers = new Map(users.map((user) => [String(user._id), user.name]));
  return { items: rows.map((row) => bundleView(row, makers)), pagination };
}

/**
 * The people and companies behind some members, as a bulk sending needs them and as the
 * screen shows them: name, email, phone, company, and the company's open leads.
 * @param {object[]} members  Rows of bundle_members
 */
export async function describeMembers(members) {
  const ids = (field) => [
    ...new Set(
      members
        .map((item) => item[field])
        .filter(Boolean)
        .map(String),
    ),
  ];
  const [contacts, accounts, leads] = await Promise.all([
    Contact.find({ _id: { $in: ids('contactId') } })
      .select('name email phone_number designation deletedAt')
      .lean(),
    Account.find({ _id: { $in: ids('accountId') } })
      .select('name email phone_number deletedAt')
      .lean(),
    Opportunity.find({ accountId: { $in: ids('accountId') }, status: 'open', ...NOT_DELETED })
      .select('name accountId')
      .sort({ createdAt: -1 })
      .lean(),
  ]);
  const contactById = new Map(contacts.map((item) => [String(item._id), item]));
  const accountById = new Map(accounts.map((item) => [String(item._id), item]));
  const leadsByAccount = new Map();
  for (const lead of leads) {
    const key = String(lead.accountId);
    leadsByAccount.set(key, [...(leadsByAccount.get(key) ?? []), lead]);
  }
  return members.map((member) => {
    const account = accountById.get(String(member.accountId));
    const contact = member.contactId ? contactById.get(String(member.contactId)) : null;
    const source = member.kind === 'person' ? contact : account;
    const openLeads = leadsByAccount.get(String(member.accountId)) ?? [];
    return {
      id: String(member._id),
      kind: member.kind,
      contactId: member.contactId ? String(member.contactId) : null,
      accountId: String(member.accountId),
      // Gone from the CRM since it was added: shown, and skipped by a sending.
      isGone: !source || Boolean(source.deletedAt) || !account || Boolean(account.deletedAt),
      name: member.kind === 'person' ? (contact?.name ?? 'Deleted person') : (account?.name ?? ''),
      role: member.kind === 'person' ? (contact?.designation ?? null) : 'Company address',
      email: source?.email || null,
      phone: source?.phone_number || null,
      company: account ? { id: String(account._id), name: account.name } : null,
      leads: openLeads.slice(0, 3).map((lead) => ({ id: String(lead._id), name: lead.name })),
      // The lead a mail is linked to: the company's one open lead, when there is exactly one.
      leadId: openLeads.length === 1 ? String(openLeads[0]._id) : null,
    };
  });
}

/**
 * One bundle with a page of its members.
 * @param {{ page: number, pageSize: number }} query  Validated
 */
export async function getBundle(actor, bundleId, query) {
  const bundle = await loadBundle(actor, bundleId);
  const { rows, pagination } = await runListQuery(BundleMember, {
    filter: { bundleId: bundle._id },
    sort: { _id: 1 },
    page: query.page,
    pageSize: query.pageSize,
  });
  return { bundle: bundleView(bundle), members: await describeMembers(rows), pagination };
}

/**
 * The members to add for some companies and people, only from what the actor may see.
 * @param {{ accountIds?: string[], contactIds?: string[], includePeople?: boolean,
 *           includeCompany?: boolean }} pick
 */
async function resolveMembers(actor, pick) {
  const { accountIds = [], contactIds = [], includePeople = true, includeCompany = true } = pick;
  const accountScope = scopeFilter(actor, 'accounts');
  const accounts = accountIds.length
    ? await Account.find({ $and: [{ _id: { $in: accountIds } }, accountScope, NOT_DELETED] })
        .select('email phone_number')
        .lean()
    : [];
  const picked = contactIds.length
    ? await Contact.find({ _id: { $in: contactIds }, ...NOT_DELETED })
        .select('accountId')
        .lean()
    : [];
  // A person named one by one must also be of a company the actor may see.
  const theirAccounts = picked.length
    ? await Account.find({
        $and: [{ _id: { $in: picked.map((item) => item.accountId) } }, accountScope, NOT_DELETED],
      })
        .select('_id')
        .lean()
    : [];
  const seen = new Set(theirAccounts.map((item) => String(item._id)));
  const people = [
    ...picked.filter((contact) => seen.has(String(contact.accountId))),
    ...(includePeople && accounts.length
      ? await Contact.find({
          accountId: { $in: accounts.map((item) => item._id) },
          ...NOT_DELETED,
          // Somebody we cannot write to at all is not worth a place in the bundle.
          $or: [{ email: { $nin: [null, ''] } }, { phone_number: { $nin: [null, ''] } }],
        })
          .select('accountId')
          .lean()
      : []),
  ];
  const members = people.map((contact) => ({
    kind: 'person',
    key: `c:${contact._id}`,
    contactId: contact._id,
    accountId: contact.accountId,
  }));
  if (includeCompany) {
    for (const account of accounts) {
      if (!account.email && !account.phone_number) continue;
      members.push({ kind: 'company', key: `a:${account._id}`, accountId: account._id });
    }
  }
  return members;
}

/** Put members into a bundle; who is in it already is left alone. Returns how many joined. */
async function addToBundle(actor, bundle, members) {
  const have = await BundleMember.countDocuments({ bundleId: bundle._id });
  const keys = new Set(
    (await BundleMember.find({ bundleId: bundle._id }).select('key').lean()).map(
      (item) => item.key,
    ),
  );
  const fresh = [];
  for (const member of members) {
    if (keys.has(member.key)) continue;
    keys.add(member.key);
    fresh.push({ ...member, bundleId: bundle._id, addedBy: actor._id });
  }
  if (have + fresh.length > MAX_BUNDLE_MEMBERS) {
    throw badRequest(
      `A bundle holds at most ${MAX_BUNDLE_MEMBERS} addresses. This would make ${have + fresh.length}.`,
    );
  }
  if (fresh.length) {
    // Two requests at once: the unique key lets each member in once.
    await BundleMember.insertMany(fresh, { ordered: false }).catch((error) => {
      if (error?.code !== 11000 && !error?.writeErrors) throw error;
    });
  }
  const memberCount = await BundleMember.countDocuments({ bundleId: bundle._id });
  await Bundle.updateOne({ _id: bundle._id }, { $set: { memberCount } });
  return { added: memberCount - have, memberCount };
}

/**
 * Make a bundle, empty or from companies and people.
 * @param {{ name: string, accountIds?: string[], contactIds?: string[],
 *           includePeople?: boolean, includeCompany?: boolean,
 *           members?: object[] }} data  Validated. `members`: ready rows (from a sending)
 */
export async function createBundle(actor, data, context = {}) {
  const members = data.members ?? (await resolveMembers(actor, data));
  const bundle = (await Bundle.create({ name: data.name, createdBy: actor._id })).toObject();
  let result;
  try {
    result = await addToBundle(actor, bundle, members);
  } catch (error) {
    await Bundle.deleteOne({ _id: bundle._id });
    throw error;
  }
  await writeAudit({
    actor,
    action: 'bundle.created',
    entityType: 'bundles',
    entityId: bundle._id,
    newValue: { name: bundle.name, members: result.memberCount },
    requestId: context.requestId,
  });
  return { ...bundleView({ ...bundle, memberCount: result.memberCount }), added: result.added };
}

export async function renameBundle(actor, bundleId, { name }, context = {}) {
  const bundle = await loadBundle(actor, bundleId);
  await Bundle.updateOne({ _id: bundle._id }, { $set: { name } });
  await writeAudit({
    actor,
    action: 'bundle.renamed',
    entityType: 'bundles',
    entityId: bundle._id,
    oldValue: { name: bundle.name },
    newValue: { name },
    requestId: context.requestId,
  });
  return bundleView({ ...bundle, name });
}

/** The sendings that were made from it keep their own lists of who got what. */
export async function deleteBundle(actor, bundleId, context = {}) {
  const bundle = await loadBundle(actor, bundleId);
  await BundleMember.deleteMany({ bundleId: bundle._id });
  await Bundle.deleteOne({ _id: bundle._id });
  await writeAudit({
    actor,
    action: 'bundle.deleted',
    entityType: 'bundles',
    entityId: bundle._id,
    oldValue: { name: bundle.name, members: bundle.memberCount },
    requestId: context.requestId,
  });
  return { deleted: true };
}

/** @param {{ accountIds?: string[], contactIds?: string[], includePeople?: boolean,
 *            includeCompany?: boolean }} pick  Validated */
export async function addBundleMembers(actor, bundleId, pick) {
  const bundle = await loadBundle(actor, bundleId);
  return addToBundle(actor, bundle, await resolveMembers(actor, pick));
}

export async function removeBundleMember(actor, bundleId, memberId) {
  const bundle = await loadBundle(actor, bundleId);
  const removed = await BundleMember.deleteOne({ _id: memberId, bundleId: bundle._id });
  if (removed.deletedCount === 0) throw notFound('This address is not in the bundle.');
  const memberCount = await BundleMember.countDocuments({ bundleId: bundle._id });
  await Bundle.updateOne({ _id: bundle._id }, { $set: { memberCount } });
  return { removed: true, memberCount };
}

/**
 * People and companies that can still be added: those the actor may see, matching a search,
 * that are not in the bundle yet.
 * @param {{ search: string }} query  Validated
 */
export async function findBundleCandidates(actor, bundleId, { search }) {
  const bundle = await loadBundle(actor, bundleId);
  const pattern = containsPattern(search);
  const accountScope = scopeFilter(actor, 'accounts');
  const accounts = await Account.find({ $and: [accountScope, NOT_DELETED, { name: pattern }] })
    .select('name email phone_number')
    .limit(10)
    .lean();
  const contacts = await Contact.find({
    ...NOT_DELETED,
    $or: [
      { name: pattern },
      { email: pattern },
      { accountId: { $in: accounts.map((a) => a._id) } },
    ],
  })
    .select('name email phone_number accountId')
    .limit(40)
    .lean();
  const visible = await Account.find({
    $and: [{ _id: { $in: contacts.map((item) => item.accountId) } }, accountScope, NOT_DELETED],
  })
    .select('name')
    .lean();
  const companyName = new Map(visible.map((item) => [String(item._id), item.name]));
  const taken = new Set(
    (await BundleMember.find({ bundleId: bundle._id }).select('key').lean()).map(
      (item) => item.key,
    ),
  );
  return [
    ...contacts
      .filter((item) => companyName.has(String(item.accountId)) && !taken.has(`c:${item._id}`))
      .map((item) => ({
        kind: 'person',
        contactId: String(item._id),
        name: item.name,
        email: item.email || null,
        phone: item.phone_number || null,
        company: companyName.get(String(item.accountId)),
      })),
    ...accounts
      .filter((item) => (item.email || item.phone_number) && !taken.has(`a:${item._id}`))
      .map((item) => ({
        kind: 'company',
        accountId: String(item._id),
        name: item.name,
        email: item.email || null,
        phone: item.phone_number || null,
        company: item.name,
      })),
  ].slice(0, 30);
}
