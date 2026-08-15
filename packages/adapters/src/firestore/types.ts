import type { Timestamp } from 'firebase-admin/firestore'
import type {
  Attribution,
  ChargerDecision,
  CycleInputs,
  OpMode,
  Phases,
  SupplyLine,
} from '@app/core'

/** Document shapes, one per collection in data-model.md. */

export type ParkingLotDoc = {
  lotNumber: string
  chargerId: string
  serialNumber: string
  /** Empty means the lot is orphaned — surfaced in the admin view (spec edge case). */
  easeeUserId: string
  line: SupplyLine
  phases: Phases
  maxCurrentA: number
}

export type Discrepancy = 'none' | 'capped' | 'lost'

export type ChargerDoc = {
  chargerId: string
  lotNumber: string
  line: SupplyLine
  phases: Phases
  maxCurrentA: number
  opMode: OpMode
  outputCurrentA: number
  dynamicChargerCurrentA: number
  totalPowerKw: number
  sessionEnergyKwh: number
  lifetimeEnergyKwh: number
  reasonForNoCurrent: number
  commandedCurrentA: number
  commandedAt: string | null
  discrepancy: Discrepancy
  activeSessionId: string | null
  activeTargetPath: string | null
  overrideActive: boolean
  overrideSince: string | null
  observedAt: string | null
  consecutiveAboveFloor: number
  consecutiveBelowFloor: number
  /** Last snapshot write, so snapshotting stays at ~15 minutes rather than per cycle (FR-046). */
  lastSnapshotAt: string | null
  /**
   * The attribution of the *last* command. Energy observed this cycle was produced by the previous
   * cycle's setpoint, so the solar/grid split must be credited to that decision, not this one.
   */
  lastAttribution: Attribution
  /**
   * Energy delivered since the target and session documents were last written.
   *
   * The charger mirror is written once per cycle anyway, in a single batch for all thirty; the
   * target and session documents are not. Accumulating here and flushing every ~15 minutes is what
   * keeps this from becoming one write per charger per cycle, which FR-046 forbids and which alone
   * would take a busy day from ~1,700 writes to ~3,000.
   *
   * Nothing reads a stale figure because of it: `gather` adds the pending amount to the target's
   * delivered energy before the core sees it, and the API does the same before the user does.
   */
  pendingKwh: number
  pendingSolarKwh: number
  pendingGridKwh: number
  lastFlushAt: string | null
}

export type UserDoc = {
  userId: string
  email: string | null
  lotNumbers: string[]
  createdAt: string
  lastSeenAt: string
}

export type TargetStatus = 'open' | 'met' | 'shortfall' | 'cancelled' | 'superseded'

export type TargetDoc = {
  targetId: string
  userId: string
  chargerId: string
  lotNumber: string
  energyKwh: number
  deadline: string
  status: TargetStatus
  deliveredKwh: number
  deliveredSolarKwh: number
  deliveredGridKwh: number
  reachability: {
    state: 'reachable' | 'at_risk' | 'unreachable'
    expectedShortfallKwh: number
    evaluatedAt: string
  }
  createdAt: string
  closedAt: string | null
}

export type SessionEndReason = 'target_reached' | 'unplugged' | 'cancelled' | 'deadline_passed'

export type SessionDoc = {
  sessionId: string
  userId: string
  chargerId: string
  lotNumber: string
  startedAt: string
  endedAt: string | null
  energyKwh: number
  solarKwh: number
  gridKwh: number
  targetEnergyKwh: number | null
  deadline: string | null
  targetMet: boolean
  endReason: SessionEndReason | null
  overrideUsed: boolean
  /** Observation 121 at session open, so delivered energy is a difference, not an absolute. */
  sessionEnergyAtStartKwh: number
}

export type ChargerEventType =
  | 'plugged_in'
  | 'unplugged'
  | 'charging_started'
  | 'charging_stopped'
  | 'target_set'
  | 'override_on'
  | 'override_off'
  | 'command_lost'
  | 'command_capped'
  | 'error'

export type ChargerEventDoc = {
  type: ChargerEventType
  chargerId: string
  lotNumber: string
  at: string
  detail: string | null
  cycleId: string | null
  expiresAt: Timestamp
}

export type ChargerSnapshotDoc = {
  chargerId: string
  lotNumber: string
  opMode: OpMode
  outputCurrentA: number
  commandedCurrentA: number
  totalPowerKw: number
  sessionEnergyKwh: number
  observedAt: string
  expiresAt: Timestamp
}

export type CycleOutcome = 'completed' | 'skipped_locked' | 'failed' | 'degraded'

export type ProviderCallStatsDoc = {
  calls: number
  errors: number
  rateLimited: number
  budgetRemaining: number
}

export type ReadBackDoc = {
  chargerId: string
  commandedCurrentA: number
  deliveredCurrentA: number
  dynamicChargerCurrentA: number
  discrepancy: Discrepancy
}

export type CycleDoc = {
  cycleId: string
  startedAt: string
  finishedAt: string | null
  outcome: CycleOutcome
  durationMs: number
  /** The complete replay input; `null` only for a cycle that never got as far as gathering. */
  inputs: CycleInputs | null
  decisions: ChargerDecision[]
  readBack: ReadBackDoc[]
  providerCalls: Record<'easee' | 'solaredge' | 'openweather', ProviderCallStatsDoc>
  notes: string[]
  surplusAllocatedKw: number
  schedulerVersion: string
  correlationId: string
  /** Count of documents this cycle wrote — keeps the Principle VI budget observable, not assumed. */
  firestoreWrites: number
  expiresAt: Timestamp
}

export type FairnessDoc = {
  userId: string
  /** Rolling 30-day total of solar energy received (FR-024). */
  solarKwhReceived: number
  windowStart: string
  lastServedCycleId: string | null
}

export type LeaseDoc = {
  holder: string
  acquiredAt: string
  expiresAt: string
}

export type ProviderTokenDoc = {
  accessToken: string
  refreshToken: string
  expiresAt: string
}

export type AttributionOf = Attribution
