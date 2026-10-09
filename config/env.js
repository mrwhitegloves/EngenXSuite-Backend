import { z } from 'zod';

// One place that reads process.env. Everything else imports `env` from here,
// so a missing or malformed variable is caught once, at startup, with a clear message.

const mongoUri = z
  .string()
  .regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  // Public address of the client. Used for redirects after login and for the OAuth callback URL.
  APP_URL: z.url().default('http://localhost:5173'),
  // First-run defaults only. The live product and company names live in the settings record.
  APP_NAME: z.string().min(1).default('EngenXSuite'),
  COMPANY_NAME: z.string().min(1).default('EngenX'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  // Production database. Required everywhere so a deploy can never start without it.
  MONGODB_URI: mongoUri,
  // Development database. When set, it is used for every run that is not production,
  // so local work and seed data never touch the production database.
  MONGODB_URI_DEV: mongoUri.optional(),

  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  GOOGLE_SIGNIN_CLIENT_ID: z.string().min(1),
  GOOGLE_SIGNIN_CLIENT_SECRET: z.string().min(1),
  // Only accounts on this domain may connect Gmail and Calendar (phase 06).
  WORKSPACE_DOMAIN: z.string().min(1).default('engenx.in'),

  // Used only by the seed script: the first CEO user.
  SEED_CEO_EMAIL: z.email().optional(),
});

// A variable written as "NAME=" in .env arrives as an empty string. Treat that as "not set",
// so optional settings can be left blank and defaults apply.
function withoutEmptyValues(rawEnv) {
  return Object.fromEntries(Object.entries(rawEnv).filter(([, value]) => value !== ''));
}

/**
 * Validate a raw environment object.
 * Kept separate from the module-level `env` so tests can call it with their own values.
 * @param {Record<string, string | undefined>} rawEnv
 */
export function parseEnv(rawEnv) {
  const result = envSchema.safeParse(withoutEmptyValues(rawEnv));
  if (!result.success) {
    // Only names and reasons are printed, never values: these are secrets.
    const problems = result.error.issues
      .map((issue) => {
        const name = issue.path.join('.') || '(root)';
        const missing = rawEnv[name] === undefined || rawEnv[name] === '';
        return `  - ${name}: ${missing ? 'is required' : issue.message}`;
      })
      .join('\n');
    // Thrown as a plain Error: at this point the logger is not configured yet.
    throw new Error(
      `Invalid environment configuration. Fix these variables in .env (see .env.example):\n${problems}`,
    );
  }

  const data = result.data;
  const useDevDatabase = data.NODE_ENV !== 'production' && Boolean(data.MONGODB_URI_DEV);
  return {
    ...data,
    // The one connection string the app uses. Nothing else should read MONGODB_URI directly.
    DATABASE_URI: useDevDatabase ? data.MONGODB_URI_DEV : data.MONGODB_URI,
    DATABASE_KIND: useDevDatabase ? 'development' : 'production',
  };
}

export const env = parseEnv(process.env);
