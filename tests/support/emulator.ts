import net from 'node:net'
import { getDb } from '@app/adapters'

/** Avoids a direct `firebase-admin` import so this helper needs no dependency of its own. */
type Firestore = ReturnType<typeof getDb>

/**
 * Integration-test support: the Firestore emulator.
 *
 * Tests that need real Firestore semantics — transactions for the lease, batched writes for session
 * retention — run against the emulator, never against production and never against a hand-written
 * fake, because a fake transaction proves nothing about single-flight execution.
 *
 * When no emulator is reachable the suites skip with a visible message rather than failing, so a
 * developer without Java installed still gets a green unit and contract run. CI always has one
 * (`.github/workflows/ci.yml` runs the suite inside `emulators:exec`).
 */
export const PROJECT_ID = process.env['GOOGLE_CLOUD_PROJECT'] ?? 'solarpowerconsumptionoptimizer'
export const EMULATOR_HOST = process.env['FIRESTORE_EMULATOR_HOST'] ?? 'localhost:8080'

export async function emulatorAvailable(timeoutMs = 750): Promise<boolean> {
  const [host = 'localhost', port = '8080'] = EMULATOR_HOST.split(':')
  return new Promise((resolve) => {
    const socket = new net.Socket()
    const done = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
    socket.connect(Number(port), host)
  })
}

export function testDb(): Firestore {
  // firebase-admin routes to the emulator purely on the presence of this variable.
  process.env['FIRESTORE_EMULATOR_HOST'] = EMULATOR_HOST
  return getDb(PROJECT_ID)
}

/** Wipes every collection between tests, so ordering never leaks state between suites. */
export async function clearFirestore(): Promise<void> {
  const response = await fetch(
    `http://${EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: 'DELETE' },
  )
  if (!response.ok) {
    throw new Error(`failed to clear the Firestore emulator: ${response.status}`)
  }
}

/** `describe.skipIf(await noEmulator())` reads better than repeating the message everywhere. */
export async function noEmulator(): Promise<boolean> {
  const available = await emulatorAvailable()
  if (!available) {
    console.warn(
      `\n[skipped] No Firestore emulator on ${EMULATOR_HOST}. Start one with ` +
        `\`pnpm emulators\` (needs Java 11+) to run the integration suite.\n`,
    )
  }
  return !available
}
