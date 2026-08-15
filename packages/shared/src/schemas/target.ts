import { z } from 'zod'
import { IsoInstant, Reachability } from './common.js'

export const TargetStatus = z.enum(['open', 'met', 'shortfall', 'cancelled', 'superseded'])
export type TargetStatus = z.infer<typeof TargetStatus>

/** `POST /chargers/{lotNumber}/target` — both values come from sliders (FR-006). */
export const SetTargetRequest = z.object({
  energyKwh: z.number().min(1).max(100),
  deadline: IsoInstant,
})
export type SetTargetRequest = z.infer<typeof SetTargetRequest>

export const SetTargetResponse = z.object({
  targetId: z.string().min(1),
  reachability: Reachability,
})
export type SetTargetResponse = z.infer<typeof SetTargetResponse>

/** The target block the PWA renders (contracts/user-api.md, `GET /chargers`). */
export const TargetView = z.object({
  targetId: z.string().min(1),
  energyKwh: z.number(),
  deadline: IsoInstant,
  deliveredKwh: z.number(),
  remainingKwh: z.number(),
  solarKwh: z.number(),
  gridKwh: z.number(),
  reachability: Reachability,
})
export type TargetView = z.infer<typeof TargetView>
