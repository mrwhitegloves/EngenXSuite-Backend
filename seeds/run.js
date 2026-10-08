import { env } from '../config/env.js';
import { logger } from '../infra/logger.js';
import { connectMongo, disconnectMongo } from '../infra/mongo.js';
import { runSeed } from './seed.js';

// Command-line entry for the seed:  npm run seed
// Uses the same database the app would use (development unless NODE_ENV=production).

async function main() {
  logger.info({ database: env.DATABASE_KIND }, 'Seeding database');
  await connectMongo(env.DATABASE_URI);
  try {
    const result = await runSeed({
      ceoEmail: env.SEED_CEO_EMAIL,
      productName: env.APP_NAME,
      companyName: env.COMPANY_NAME,
      workspaceDomain: env.WORKSPACE_DOMAIN,
    });
    logger.info(result, 'Seed finished');
  } finally {
    await disconnectMongo();
  }
}

main().catch((error) => {
  logger.fatal({ err: error }, 'Seed failed');
  process.exit(1);
});
