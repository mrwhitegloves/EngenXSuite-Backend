import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { Settings } from '../models/settings.model.js';
import { PipelineStage } from '../models/pipelineStage.model.js';
import { SolutionCategory } from '../models/solutionCategory.model.js';
import { DEFAULT_ROLE_GRANTS } from '../constants/permissions.js';
import { AccountStatus, LeadStatus } from '../models/statusLists.model.js';
import {
  DEFAULT_ACCOUNT_STATUSES,
  DEFAULT_LEAD_STATUSES,
  DEFAULT_PIPELINE_STAGES,
  DEFAULT_SOLUTION_CATEGORIES,
} from './defaults.js';

// Creates the data the app cannot start without: runSeed() makes the three roles, the settings
// record and the first CEO user; seedStartingLists() makes the starting pipeline stages and
// solution categories. `npm run seed` runs both. Safe to run any number of times: it only creates what is missing and never
// overwrites something an administrator has changed in the app.

const ROLE_DESCRIPTIONS = {
  CEO: 'Full access to everything.',
  'Sales Manager': 'Works with their own records and those of the people who report to them.',
  'Sales Agent': 'Works only with records assigned to them.',
};

/**
 * @param {{ ceoEmail?: string, productName: string, companyName: string, workspaceDomain: string,
 *           resetRoleGrants?: boolean }} options
 *   resetRoleGrants: also overwrite the grants of the three built-in roles with the current
 *   defaults. Only for a deliberate run after the defaults changed in code: it discards any
 *   change an administrator made to those roles.
 * @returns {Promise<{ rolesCreated: string[], settingsCreated: boolean, ceoCreated: boolean }>}
 */
export async function runSeed({
  ceoEmail,
  productName,
  companyName,
  workspaceDomain,
  resetRoleGrants = false,
}) {
  const rolesCreated = [];
  for (const [name, grants] of Object.entries(DEFAULT_ROLE_GRANTS)) {
    if (resetRoleGrants) await Role.updateOne({ name, isSystem: true }, { $set: { grants } });
    const result = await Role.updateOne(
      { name },
      // $setOnInsert: written only when the role does not exist yet.
      { $setOnInsert: { name, description: ROLE_DESCRIPTIONS[name], isSystem: true, grants } },
      { upsert: true },
    );
    if (result.upsertedCount > 0) rolesCreated.push(name);
  }

  const settingsResult = await Settings.updateOne(
    { key: 'app' },
    { $setOnInsert: { key: 'app', branding: { productName, companyName } } },
    { upsert: true },
  );

  // The first CEO is created only while no CEO-role user exists at all.
  let ceoCreated = false;
  const ceoRole = await Role.findOne({ name: 'CEO' }).select('_id').lean();
  const ceoExists = await User.exists({ roleId: ceoRole._id });
  if (!ceoExists && ceoEmail) {
    const email = ceoEmail.trim().toLowerCase();
    await User.create({
      email,
      // Replaced by the Google profile name on the first sign-in.
      name: email,
      roleId: ceoRole._id,
      status: 'invited',
      isWorkspaceAccount: email.endsWith(`@${workspaceDomain.toLowerCase()}`),
    });
    ceoCreated = true;
  }

  return { rolesCreated, settingsCreated: settingsResult.upsertedCount > 0, ceoCreated };
}

/**
 * The starting pipeline stages and solution categories. Each list is written only into an
 * EMPTY collection: once an administrator has any stage or category, the seed leaves the whole
 * list alone and never brings back one that was deleted or renamed. Safe to run any number of times.
 * @returns {Promise<{ stagesCreated: number, categoriesCreated: number }>}
 */
export async function seedStartingLists() {
  let stagesCreated = 0;
  if ((await PipelineStage.estimatedDocumentCount()) === 0) {
    const stages = DEFAULT_PIPELINE_STAGES.map(({ probability, ...stage }, index) => ({
      ...stage,
      order: (index + 1) * 10,
      defaultProbability: probability,
    }));
    stagesCreated = (await PipelineStage.insertMany(stages)).length;
  }

  let categoriesCreated = 0;
  if ((await SolutionCategory.estimatedDocumentCount()) === 0) {
    const categories = DEFAULT_SOLUTION_CATEGORIES.map((name, index) => ({
      name,
      order: (index + 1) * 10,
    }));
    categoriesCreated = (await SolutionCategory.insertMany(categories)).length;
  }

  return { stagesCreated, categoriesCreated };
}

/** "Contact Attempt 1" → "contact_attempt_1": the fixed identifier of a seeded status. */
const statusKey = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * The starting account statuses and lead statuses (managed in Settings → Statuses afterwards).
 * Like the lists above, each is written only into an EMPTY collection. The first status of each
 * list is its default. Safe to run any number of times.
 * @returns {Promise<{ accountStatusesCreated: number, leadStatusesCreated: number }>}
 */
export async function seedStatusLists() {
  const fill = async (model, names) => {
    if ((await model.estimatedDocumentCount()) > 0) return 0;
    const statuses = names.map((name, index) => ({
      name,
      key: statusKey(name),
      order: (index + 1) * 10,
      isDefault: index === 0,
    }));
    return (await model.insertMany(statuses)).length;
  };
  return {
    accountStatusesCreated: await fill(AccountStatus, DEFAULT_ACCOUNT_STATUSES),
    leadStatusesCreated: await fill(LeadStatus, DEFAULT_LEAD_STATUSES),
  };
}
