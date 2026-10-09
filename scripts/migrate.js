import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';
import {
  createMigrationFile,
  getMigrationStatus,
  runPendingMigrations,
  undoLastMigration,
} from '../infra/migrations.js';
import { connectMongo, disconnectMongo } from '../infra/mongo.js';

// Command-line entry for migrations (see migrations/README.md):
//   npm run migrate                    run the pending migrations
//   npm run migrate -- status          list every migration and when it ran
//   npm run migrate -- create <name>   make a new, empty migration file
//   npm run migrate -- down            undo the most recent migration

async function main() {
  const [command = 'up', name] = process.argv.slice(2);

  if (command === 'create') {
    logger.info({ file: await createMigrationFile(name) }, 'Migration file created');
    return;
  }
  if (!['up', 'status', 'down'].includes(command)) {
    throw new Error(`Unknown command "${command}". Use: up, status, create <name>, down`);
  }

  logger.info({ database: env.DATABASE_KIND }, `Migrations: ${command}`);
  await connectMongo(env.DATABASE_URI);
  try {
    if (command === 'status') {
      logger.info({ migrations: await getMigrationStatus() }, 'Migration status');
    } else if (command === 'down') {
      logger.info({ undone: await undoLastMigration() }, 'Most recent migration undone');
    } else {
      logger.info({ applied: await runPendingMigrations() }, 'Migrations finished');
    }
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Migration command failed');
  process.exit(1);
});
