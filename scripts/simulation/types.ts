import { z } from 'zod'

/**
 * A recorded day (T045).
 *
 * A fixture describes the *world* — who is plugged in, what the site was exporting, what the
 * external load manager allowed — and never the expected decisions. The decisions come from the
 * real `packages/core`, which is the only way the replay can be evidence of anything.
 */

const Iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 instant')

export const FixtureLot = z.object({
  lotNumber: z.string(),
  chargerId: z.string(),
  serialNumber: z.string().default('SN000000'),
  easeeUserId: z.string(),
  line: z.enum(['L1', 'L2']),
  phases: z.union([z.literal(1), z.literal(3)]),
  maxCurrentA: z.number().positive(),
})

export const FixtureTarget = z.object({
  lotNumber: z.string(),
  energyKwh: z.number().positive(),
  deadline: Iso,
  deliveredKwh: z.number().min(0).default(0),
})

/** When each car is physically connected. Outside these windows the charger reports `1`. */
export const FixturePlugged = z.object({
  lotNumber: z.string(),
  from: Iso,
  to: Iso,
  /**
   * A cap the *external* load manager imposes, in amps. The simulator delivers no more than this
   * however much this system commands — which is how a `capped` read-back is reproduced.
   */
  externalCapA: z.number().min(0).optional(),
  /** Simulates Easee resetting `dynamicChargerCurrent` on plug-in (research R5). */
  resetsSetpointOnPlugIn: z.boolean().default(true),
})

export const FixtureSurplusSample = z.object({
  at: Iso,
  gridExportKw: z.number(),
  loadKw: z.number().default(0),
  pvKw: z.number().default(0),
})

export const FixtureDay = z.object({
  name: z.string(),
  description: z.string().default(''),
  schedulerVersion: z.string().default('1.0.0'),
  site: z.object({ latitude: z.number(), longitude: z.number() }).default({
    latitude: 47.3769,
    longitude: 8.5417,
  }),
  lots: z.array(FixtureLot).min(1),
  targets: z.array(FixtureTarget).default([]),
  plugged: z.array(FixturePlugged).default([]),
  /** Overrides active for a window, for the US4 scenario. */
  overrides: z.array(z.object({ lotNumber: z.string(), from: Iso, to: Iso })).default([]),
  surplus: z
    .object({
      /** `none` = the provider is never called or never answers (the V3 outage case). */
      mode: z.enum(['none', 'series']).default('none'),
      samples: z.array(FixtureSurplusSample).default([]),
      /** After this instant every read fails, simulating the SolarEdge outage in V3. */
      failsFrom: Iso.optional(),
    })
    .default({ mode: 'none', samples: [] }),
  forecast: z
    .object({
      cloudCoverRestOfTodayPct: z.number(),
      cloudCoverTomorrowPct: z.number(),
      fetchedAt: Iso,
    })
    .nullable()
    .default(null),
  cycles: z.object({ from: Iso, to: Iso, stepMinutes: z.number().int().positive().default(5) }),
})

export type FixtureDay = z.infer<typeof FixtureDay>
export type FixtureLot = z.infer<typeof FixtureLot>
export type FixturePlugged = z.infer<typeof FixturePlugged>

export function parseFixtureDay(raw: unknown): FixtureDay {
  const parsed = FixtureDay.safeParse(raw)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`invalid fixture day:\n${problems}`)
  }
  return parsed.data
}
