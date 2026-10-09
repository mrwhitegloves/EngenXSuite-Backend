import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import {
  CHANGELOG_COLLECTION,
  MIGRATIONS_DIR,
  createMigrationFile,
  getMigrationStatus,
  runPendingMigrations,
  undoLastMigration,
} from '../infra/migrations.js';
import { clearTestDb, startTestDb, stopTestDb } from './helpers/testDb.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOOD = { migrationsDir: path.join(here, 'fixtures', 'migrations') };
const FAILING = { migrationsDir: path.join(here, 'fixtures', 'migrations-failing') };

const db = () => mongoose.connection.db;
const people = () => db().collection('sample_people').find({}).sort({ _id: 1 }).toArray();

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(clearTestDb);

describe('database migrations', () => {
  it('runs pending migrations in order, once', async () => {
    expect(await runPendingMigrations(GOOD)).toEqual([
      '20260101000000-add-sample-people.js',
      '20260102000000-rename-fullname.js',
    ]);
    expect(await people()).toEqual([
      { _id: 1, name: 'Asha' },
      { _id: 2, name: 'Kunal' },
    ]);

    // A second start finds nothing to do and changes nothing.
    expect(await runPendingMigrations(GOOD)).toEqual([]);
    expect(await people()).toHaveLength(2);
    expect(await db().collection(CHANGELOG_COLLECTION).countDocuments()).toBe(2);
  });

  it('reports which migrations ran and which are pending', async () => {
    const before = await getMigrationStatus(GOOD);
    expect(before.map((item) => item.appliedAt)).toEqual(['PENDING', 'PENDING']);

    await runPendingMigrations(GOOD);
    const after = await getMigrationStatus(GOOD);
    expect(after.map((item) => item.fileName)).toEqual([
      '20260101000000-add-sample-people.js',
      '20260102000000-rename-fullname.js',
    ]);
    expect(after.every((item) => !Number.isNaN(Date.parse(item.appliedAt)))).toBe(true);
  });

  it('undoes the most recent migration, which can then run again', async () => {
    await runPendingMigrations(GOOD);
    expect(await undoLastMigration(GOOD)).toEqual(['20260102000000-rename-fullname.js']);
    expect((await people())[0]).toEqual({ _id: 1, fullname: 'Asha' });

    expect(await runPendingMigrations(GOOD)).toEqual(['20260102000000-rename-fullname.js']);
    expect((await people())[0]).toEqual({ _id: 1, name: 'Asha' });
  });

  it('stops at a failing migration: it is not recorded, and later ones do not run', async () => {
    await expect(runPendingMigrations(FAILING)).rejects.toThrow(/this migration is broken/);

    const steps = await db().collection('sample_steps').find({}).toArray();
    expect(steps).toEqual([{ _id: 'first' }]);
    const status = await getMigrationStatus(FAILING);
    expect(status.map((item) => item.appliedAt === 'PENDING')).toEqual([false, true, true]);

    // The next start tries the failed one again.
    await expect(runPendingMigrations(FAILING)).rejects.toThrow(/this migration is broken/);
    expect(await db().collection('sample_steps').countDocuments()).toBe(1);
  });

  it('creates a new migration file with a sortable name and never overwrites one', async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'migrations-'));
    try {
      const options = { migrationsDir: folder, now: new Date('2026-10-09T08:30:05.000Z') };
      const filePath = await createMigrationFile('rename-stage-field', options);
      expect(path.basename(filePath)).toBe('20261009083005-rename-stage-field.js');
      const text = await readFile(filePath, 'utf8');
      expect(text).toContain('export async function up(db)');
      expect(text).toContain('export async function down(db)');

      await expect(createMigrationFile('rename-stage-field', options)).rejects.toThrow();
      for (const badName of ['', 'Has Spaces', '../escape', 'UPPER']) {
        await expect(createMigrationFile(badName, options)).rejects.toThrow(/small letters/);
      }
      // The new, empty migration runs without error.
      expect(await runPendingMigrations({ migrationsDir: folder })).toHaveLength(1);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('every real migration has a sortable name, up and down, and runs on an empty database', async () => {
    const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.js'));
    for (const fileName of files) {
      expect(fileName).toMatch(/^\d{14}-[a-z0-9]+(-[a-z0-9]+)*\.js$/);
      const migration = await import(pathToFileURL(path.join(MIGRATIONS_DIR, fileName)).href);
      expect(typeof migration.up, fileName).toBe('function');
      expect(typeof migration.down, fileName).toBe('function');
    }
    expect(await runPendingMigrations()).toEqual(files.sort());
    expect(await runPendingMigrations()).toEqual([]);
  });
});
