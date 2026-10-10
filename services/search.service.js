import { can } from '../lib/can.js';
import { containsPattern } from '../lib/queryBuilder.js';
import { scopeFilter } from '../lib/scopeFilter.js';
import { Account } from '../models/account.model.js';
import { Contact } from '../models/contact.model.js';
import { Opportunity } from '../models/opportunity.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { Task } from '../models/task.model.js';

// Global search (the box in the top bar): companies, people, leads and tasks in one answer.
//
// Every part of the answer uses the same scope as that record's own list, so the search can
// never show something the person may not see: an agent finds only their own companies and
// leads (decision 0008), whatever they type.

const NOT_DELETED = { deletedAt: null };
// How many results of each kind one search shows.
export const SEARCH_LIMIT = 6;
const isUnrestricted = (scope) => Object.keys(scope).length === 0;
const and = (...conditions) => ({
  $and: conditions.filter((condition) => condition && Object.keys(condition).length > 0),
});

/**
 * How to look for the text in phone fields: by its digits, without spaces, dashes, a leading
 * zero or "+91" in front. null when the text is not (mostly) a number.
 */
function phonePattern(text) {
  const digits = text.replace(/\D/g, '').replace(/^(0+|91(?=\d{10}$))/, '');
  if (digits.length < 4 || /[a-z]/i.test(text)) return null;
  return new RegExp(digits);
}

/**
 * @param {object} actor
 * @param {{ q: string }} query  Validated: at least 2 characters
 * @returns {Promise<{ accounts: object[], contacts: object[], leads: object[], tasks: object[] }>}
 */
export async function searchEverything(actor, { q }) {
  const text = containsPattern(q);
  const phone = phonePattern(q);
  const sees = (feature) => can(actor, 'view', { feature });
  const accountScope = scopeFilter(actor, 'accounts');
  const leadScope = scopeFilter(actor, 'opportunities');

  // Companies and people whose name (or phone) matches, whoever owns them. Used only to find
  // leads by their company or contact; the leads themselves are filtered by the lead scope.
  const [namedAccountIds, namedContactIds] = await Promise.all([
    Account.distinct('_id', { ...NOT_DELETED, name: text }),
    Contact.distinct('_id', {
      ...NOT_DELETED,
      $or: [{ name: text }, ...(phone ? [{ phone_number: phone }] : [])],
    }),
  ]);
  // The companies the person may see: needed to scope people (a person is seen with their company).
  const visibleAccountIds =
    sees('contacts') && !isUnrestricted(accountScope)
      ? await Account.distinct('_id', and(accountScope, NOT_DELETED))
      : null;

  // Tasks: one's own, plus what the tasks permission reaches; never a task about a lead outside
  // the lead scope.
  const taskScope = scopeFilter(actor, 'tasks', {
    ownerField: 'assigneeId',
    assignedField: 'createdBy',
  });
  const myTasks = isUnrestricted(taskScope)
    ? null
    : { $or: [taskScope, { assigneeId: actor._id }, { createdBy: actor._id }] };
  const tasksOfVisibleLeads =
    !sees('tasks') || isUnrestricted(leadScope)
      ? null
      : {
          $or: [
            { opportunityId: null },
            {
              opportunityId: {
                $in: await Opportunity.distinct('_id', and(leadScope, NOT_DELETED)),
              },
            },
          ],
        };

  const [accounts, contacts, leads, tasks] = await Promise.all([
    sees('accounts')
      ? Account.find(
          and(accountScope, NOT_DELETED, {
            $or: [
              { name: text },
              { accountCode: text },
              { email: text },
              { 'hq.city': text },
              ...(phone ? [{ phone_number: phone }] : []),
            ],
          }),
        )
          .select('name accountCode industry hq.city')
          .sort({ name: 1 })
          .limit(SEARCH_LIMIT)
          .lean()
      : [],
    sees('contacts') && sees('accounts')
      ? Contact.find(
          and(NOT_DELETED, visibleAccountIds ? { accountId: { $in: visibleAccountIds } } : null, {
            $or: [
              { name: text },
              { email: text },
              { designation: text },
              ...(phone ? [{ phone_number: phone }, { alt_phone_number: phone }] : []),
            ],
          }),
        )
          .select('name designation phone_number email accountId')
          .sort({ name: 1 })
          .limit(SEARCH_LIMIT)
          .lean()
      : [],
    sees('opportunities')
      ? Opportunity.find(
          and(leadScope, NOT_DELETED, {
            $or: [
              { name: text },
              { leadCode: text },
              { accountId: { $in: namedAccountIds } },
              { primaryContactId: { $in: namedContactIds } },
            ],
          }),
        )
          .select('name leadCode accountId stageId status estimatedValuePaise')
          .sort({ createdAt: -1 })
          .limit(SEARCH_LIMIT)
          .lean()
      : [],
    sees('tasks')
      ? Task.find(and(myTasks, tasksOfVisibleLeads, { title: text }))
          .select('title status dueAt opportunityId accountId')
          .sort({ status: 1, dueAt: 1 })
          .limit(SEARCH_LIMIT)
          .lean()
      : [],
  ]);

  // Names for what the results point at.
  const ids = (items, field) => [...new Set(items.map((item) => item[field]).filter(Boolean))];
  const [accountNames, stageNames] = await Promise.all([
    Account.find({ _id: { $in: [...ids(contacts, 'accountId'), ...ids(leads, 'accountId')] } })
      .select('name')
      .lean(),
    PipelineStage.find({ _id: { $in: ids(leads, 'stageId') } })
      .select('name')
      .lean(),
  ]);
  const nameOf = (list, id) => list.find((item) => String(item._id) === String(id))?.name ?? null;

  return {
    accounts: accounts.map((account) => ({
      id: String(account._id),
      name: account.name,
      accountCode: account.accountCode,
      detail: [account.industry, account.hq?.city].filter(Boolean).join(' · ') || null,
    })),
    contacts: contacts.map((contact) => ({
      id: String(contact._id),
      name: contact.name,
      accountId: String(contact.accountId),
      detail:
        [contact.designation, nameOf(accountNames, contact.accountId), contact.phone_number]
          .filter(Boolean)
          .join(' · ') || null,
    })),
    leads: leads.map((lead) => ({
      id: String(lead._id),
      name: lead.name,
      leadCode: lead.leadCode,
      detail:
        [nameOf(accountNames, lead.accountId), nameOf(stageNames, lead.stageId)]
          .filter(Boolean)
          .join(' · ') || null,
    })),
    tasks: tasks.map((task) => ({
      id: String(task._id),
      name: task.title,
      leadId: task.opportunityId ? String(task.opportunityId) : null,
      accountId: task.accountId ? String(task.accountId) : null,
      detail: task.status === 'done' ? 'Done' : task.dueAt ? 'Open, has a due date' : 'Open',
    })),
  };
}
