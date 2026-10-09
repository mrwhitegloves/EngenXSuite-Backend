import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';
import { connectMongo, disconnectMongo } from '../infra/mongo.js';
import { createBackup } from '../services/backup.service.js';

// Command-line backup, without Redis or a running server:  npm run backup
// Backs up the database the app would use (development unless NODE_ENV=production) into that
// environment's storage bucket.

async function main() {
  logger.info({ database: env.DATABASE_KIND }, 'Backing up database');
  await connectMongo(env.DATABASE_URI);
  try {
    const result = await createBackup();
    logger.info(result, 'Backup id (needed for a restore)');
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Backup failed');
  process.exit(1);
});
