import { z } from 'zod';

// One place that reads process.env. Everything else imports `env` from here,
// so a missing or malformed variable is caught once, at startup, with a clear message.

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_URL: z.url().default('http://localhost:5173'),
  // First-run defaults only. The live product and company names live in the settings record.
  APP_NAME: z.string().min(1).default('EngenXSuite'),
  COMPANY_NAME: z.string().min(1).default('EngenX'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  MONGODB_URI: z
    .string({ error: 'MONGODB_URI is required' })
    .regex(/^mongodb(\+srv)?:\/\//, 'MONGODB_URI must start with mongodb:// or mongodb+srv://'),
});

/**
 * Validate a raw environment object.
 * Kept separate from the module-level `env` so tests can call it with their own values.
 * @param {Record<string, string | undefined>} rawEnv
 * @returns {z.infer<typeof envSchema>}
 */
export function parseEnv(rawEnv) {
  const result = envSchema.safeParse(rawEnv);
  if (result.success) return result.data;

  const problems = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Thrown as a plain Error: at this point the logger is not configured yet.
  throw new Error(
    `Invalid environment configuration. Fix these variables in .env (see .env.example):\n${problems}`,
  );
}

export const env = parseEnv(process.env);
