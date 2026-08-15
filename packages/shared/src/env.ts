import { z } from 'zod'

/**
 * Zod-validated configuration loader (T014).
 *
 * Principle VII: environment variables are external input, so they are validated at the boundary
 * rather than read ad hoc with `process.env.X!` scattered through the services. Principle V: every
 * secret named here comes from Secret Manager in production and from `.env.local` locally.
 */
const nonEmpty = z.string().min(1)

export const EnvSchema = z.object({
  GOOGLE_CLOUD_PROJECT: z.string().default('easee-solar-charger'),
  FIRESTORE_EMULATOR_HOST: z.string().optional(),

  EASEE_API_BASE: z.string().url().default('https://api.easee.com'),
  EASEE_TECHNICAL_USERNAME: z.string().optional(),
  EASEE_TECHNICAL_PASSWORD: z.string().optional(),
  EASEE_ISSUER: nonEmpty.default('https://auth.easee.com/realms/easee'),
  EASEE_JWKS_URL: z
    .string()
    .url()
    .default('https://auth.easee.com/realms/easee/protocol/openid-connect/certs'),
  EASEE_AUDIENCE: nonEmpty.default('easee'),

  SOLAREDGE_API_BASE: z.string().url().default('https://monitoringapi.solaredge.com'),
  SOLAREDGE_API_KEY: z.string().optional(),
  SOLAREDGE_SITE_ID: z.string().optional(),

  OPENWEATHER_API_BASE: z.string().url().default('https://api.openweathermap.org'),
  OPENWEATHER_API_KEY: z.string().optional(),

  SITE_LATITUDE: z.coerce.number().min(-90).max(90).default(47.3769),
  SITE_LONGITUDE: z.coerce.number().min(-180).max(180).default(8.5417),

  ADMIN_USERNAME: nonEmpty.default('admin'),
  ADMIN_PASSWORD: z.string().optional(),

  API_PORT: z.coerce.number().int().positive().default(8081),
  OPTIMIZER_PORT: z.coerce.number().int().positive().default(8082),
  /** Cloud Run injects this and expects the container to listen on it; it wins where present. */
  PORT: z.coerce.number().int().positive().optional(),
  SCHEDULER_VERSION: nonEmpty.default('1.0.0'),
})

export type AppEnv = z.infer<typeof EnvSchema>

type RawEnv = Record<string, string | undefined>

function ambientEnv(): RawEnv {
  const g = globalThis as { process?: { env?: RawEnv } }
  return g.process?.env ?? {}
}

/**
 * Parses and returns the configuration. Throws with the full list of problems rather than failing
 * later with a confusing `undefined` — a missing credential must stop the service at start-up, not
 * silently disable a provider mid-cycle.
 */
export function loadEnv(source: RawEnv = ambientEnv()): AppEnv {
  const parsed = EnvSchema.safeParse(source)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${problems}`)
  }
  return parsed.data
}

/** Credentials the optimizer cannot run without; checked separately so the API can start without them. */
export function requireOptimizerSecrets(env: AppEnv): {
  easeeUsername: string
  easeePassword: string
} {
  if (!env.EASEE_TECHNICAL_USERNAME || !env.EASEE_TECHNICAL_PASSWORD) {
    throw new Error(
      'EASEE_TECHNICAL_USERNAME and EASEE_TECHNICAL_PASSWORD are required by the optimizer ' +
        '(the dedicated technical account — see research.md R6).',
    )
  }
  return {
    easeeUsername: env.EASEE_TECHNICAL_USERNAME,
    easeePassword: env.EASEE_TECHNICAL_PASSWORD,
  }
}
