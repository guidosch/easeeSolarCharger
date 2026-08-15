import { getApps, initializeApp } from 'firebase-admin/app'
import { Timestamp, getFirestore } from 'firebase-admin/firestore'
import type { Firestore } from 'firebase-admin/firestore'

/**
 * Firestore access (T035).
 *
 * Time is stored two ways on purpose. Everything the replay contract touches is an **ISO string**,
 * because `decide(cycle.inputs)` has to reproduce `cycle.decisions` byte for byte (SC-010) and a
 * Timestamp round-trip is a lossy, SDK-version-dependent representation. `expiresAt` is a real
 * **Timestamp**, because a Firestore TTL policy only recognises that type — and retention is
 * enforced by the database rather than by a cleanup job that might not run (Principle VI, FR-047).
 */
export function getDb(projectId?: string): Firestore {
  if (getApps().length === 0) {
    initializeApp(projectId ? { projectId } : {})
  }
  return getFirestore()
}

export { Timestamp }

/** One month of admin monitoring data (FR-047). */
export const RETENTION_DAYS = 30

export function expiresAtFrom(nowIso: string, days = RETENTION_DAYS): Timestamp {
  return Timestamp.fromMillis(Date.parse(nowIso) + days * 24 * 60 * 60 * 1000)
}

export const COLLECTIONS = {
  parkingLots: 'parkingLots',
  chargers: 'chargers',
  users: 'users',
  targets: 'targets',
  sessions: 'sessions',
  chargerSnapshots: 'chargerSnapshots',
  chargerEvents: 'chargerEvents',
  cycles: 'cycles',
  fairness: 'fairness',
  locks: 'locks',
  providerTokens: 'providerTokens',
} as const

/** Firestore rejects `undefined`; omitting the key is the difference between "unset" and a crash. */
export function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
