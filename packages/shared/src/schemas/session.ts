import { z } from 'zod'
import { IsoInstant } from './common.js'

export const SessionEndReason = z.enum([
  'target_reached',
  'unplugged',
  'cancelled',
  'deadline_passed',
])
export type SessionEndReason = z.infer<typeof SessionEndReason>

/**
 * One charging process (FR-037). Only the five most recent are retained per user (FR-038).
 *
 * `solarKwh` / `gridKwh` follow the *reason the core chose to charge*, not a measurement — site
 * level metering cannot tell which electrons went where (data-model.md). The UI wording must say so.
 */
export const SessionSummary = z.object({
  sessionId: z.string(),
  chargerId: z.string(),
  lotNumber: z.string(),
  startedAt: IsoInstant,
  endedAt: IsoInstant.nullable(),
  energyKwh: z.number(),
  solarKwh: z.number(),
  gridKwh: z.number(),
  targetEnergyKwh: z.number().nullable(),
  deadline: IsoInstant.nullable(),
  targetMet: z.boolean(),
  endReason: SessionEndReason.nullable(),
  overrideUsed: z.boolean(),
})
export type SessionSummary = z.infer<typeof SessionSummary>
