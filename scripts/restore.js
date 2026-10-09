import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';
import { connectMongo, disconnectMongo } from '../infra/mongo.js';
import { listBackups, restoreBackup } from '../services/backup.service.js';

// Command-line restore:
//   npm run restore                                  lists the backups
//   npm run restore -- <backup id> <new database>    copies that backup into a NEW, EMPTY database
//
// It never writes into the database the app is using. After checking the restored copy, point
// the app at it by changing the database name in the connection string (docs/runbooks/backups.md).

async function main() {
  const [backupId, targetDatabase] = process.argv.slice(2);
  await connectMongo(env.DATABASE_URI);
  try {
    if (!backupId || !targetDatabase) {
      const backups = await listBackups();
      logger.info({ database: env.DATABASE_KIND, backups }, 'Available backups');
      logger.info('To restore: npm run restore -- <backup id> <new database name>');
      return;
    }
    const result = await restoreBackup({ backupId, targetDatabase });
    logger.info(result, 'Restore finished: every collection has the same number of documents');
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Restore failed');
  process.exit(1);
});
