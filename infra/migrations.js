import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { config, down, status, up } from 'migrate-mongo';
import { logger } from './logger.js';

// Database migrations (migrate-mongo). A migration is a small file in server/migrations/ that
// changes existing data or structure once: rename a field, fill a new field, fix wrong values,
// remove an index. Which files already ran is recorded in the database itself
// (collection "migrations_changelog"), so each one runs exactly once per database.
//
// Not needed for: a new collection, a new optional field, or a new index. Mongoose creates
// indexes from the schemas by itself when the server starts.
//
// The server runs the pending migrations at startup, before it accepts requests. If one fails,
// the server does not start: running new code on half-changed data would be worse.

export const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);
export const CHANGELOG_COLLECTION = 'migrations_changelog';

function configure(migrationsDir) {
  // The library is told everything here, so it needs no config file of its own. It uses the
  // connection Mongoose already opened, so "mongodb" settings are not needed.
  config.set({
    migrationsDir,
    changelogCollectionName: CHANGELOG_COLLECTION,
    migrationFileExtension: '.js',
    useFileHash: false,
    moduleSystem: 'esm',
  });
}

const connection = () => ({
  db: mongoose.connection.db,
  client: mongoose.connection.getClient(),
});

/**
 * Run every migration that has not run on this database yet, oldest first.
 * @param {{ migrationsDir?: string }} [options]  Only tests pass another folder
 * @returns {Promise<string[]>} The file names that ran now
 */
export async function runPendingMigrations({ migrationsDir = MIGRATIONS_DIR } = {}) {
  configure(migrationsDir);
  const { db, client } = connection();
  const applied = await up(db, client);
  if (applied.length > 0) logger.info({ applied }, 'Database migrations applied');
  return applied;
}

/** Every migration file with when it ran: [{ fileName, appliedAt: ISO date | 'PENDING' }]. */
export async function getMigrationStatus({ migrationsDir = MIGRATIONS_DIR } = {}) {
  configure(migrationsDir);
  const items = await status(connection().db);
  return items.map(({ fileName, appliedAt }) => ({ fileName, appliedAt }));
}

/** Undo the most recent migration, using its `down` function. Returns the file names undone. */
export async function undoLastMigration({ migrationsDir = MIGRATIONS_DIR } = {}) {
  configure(migrationsDir);
  const { db, client } = connection();
  return down(db, client);
}

const TEMPLATE = `// What this migration does and why (one or two lines).
// Rules: it must be safe to run on a database of any size, and "down" must put back what
// "up" changed. Use the plain database driver (db.collection('name')), not the models:
// models change later, a migration must keep working as written.

/** @param {import('mongodb').Db} db */
export async function up(db) {
  // await db.collection('example').updateMany({ oldField: { $exists: true } }, { $rename: { oldField: 'newField' } });
}

/** @param {import('mongodb').Db} db */
export async function down(db) {
  // await db.collection('example').updateMany({ newField: { $exists: true } }, { $rename: { newField: 'oldField' } });
}
`;

/**
 * Create an empty migration file named with the current time, so files sort in the order they
 * were written.
 * @param {string} name  For example "rename-account-industry"
 * @returns {Promise<string>} The path of the new file
 */
export async function createMigrationFile(
  name,
  { migrationsDir = MIGRATIONS_DIR, now = new Date() } = {},
) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name ?? '')) {
    throw new Error(
      'Give the migration a name in small letters with dashes, e.g. rename-stage-field',
    );
  }
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  const filePath = path.join(migrationsDir, `${stamp}-${name}.js`);
  await mkdir(migrationsDir, { recursive: true });
  // "wx": never overwrite an existing file.
  await writeFile(filePath, TEMPLATE, { flag: 'wx' });
  return filePath;
}
