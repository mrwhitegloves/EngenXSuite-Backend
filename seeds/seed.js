import { Role } from '../models/role.model.js';
import { User } from '../models/user.model.js';
import { Settings } from '../models/settings.model.js';
import { DEFAULT_ROLE_GRANTS } from '../constants/permissions.js';

// Creates the data the app cannot start without: the three roles, the settings record and the
// first CEO user. Safe to run any number of times: it only creates what is missing and never
// overwrites something an administrator has changed in the app.

const ROLE_DESCRIPTIONS = {
  CEO: 'Full access to everything.',
  'Sales Manager': 'Works with their own records and those of the people who report to them.',
  'Sales Agent': 'Works only with records assigned to them.',
};

/**
 * @param {{ ceoEmail?: string, productName: string, companyName: string, workspaceDomain: string }} options
 * @returns {Promise<{ rolesCreated: string[], settingsCreated: boolean, ceoCreated: boolean }>}
 */
export async function runSeed({ ceoEmail, productName, companyName, workspaceDomain }) {
  const rolesCreated = [];
  for (const [name, grants] of Object.entries(DEFAULT_ROLE_GRANTS)) {
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
