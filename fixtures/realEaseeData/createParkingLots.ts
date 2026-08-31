/**
 * Builds the real `parkingLots` fixture from the live Easee site (one-off operator tooling).
 *
 *   pnpm tsx --env-file-if-exists=.env.local fixtures/realEaseeData/createParkingLots.ts
 *
 * The charger list comes from `siteChargers.json`, and the lot ↔ user mapping from the per-charger
 * permission endpoint — the first user listed on a charger is taken as its owner:
 *
 * curl --request GET \
 *   --url https://api.easee.com/api/chargers/{chargerId}/permission \
 *   --header 'Authorization: Bearer eyJ****' \
 *   --header 'accept: application/json'
 *
 * example response:
 * [{"userId":530332,"name":"Guido Schnider",...},{"userId":653992,"name":"Elke Keck",...}]
 *
 * `siteUsers.json` is the cross-check: every id the API returns is resolved against it, so a lot
 * mapped to somebody who is no longer on the site shows up as a warning instead of silently
 * becoming an unusable authorization entry (FR-003 — this mapping is the *sole* basis for who may
 * act on which charger).
 *
 * `site.json` (the `GET /api/sites/{id}` response) supplies the supply line and the serial number.
 * Each charger sits on a circuit, and that circuit's `circuitPanelId` is the panel it hangs off —
 * panel 1 becomes `L1`, panel 2 becomes `L2`, which is what the optimizer's headroom check groups
 * by, so it has to come from the wiring rather than from a guess. The serial number is the
 * charger's `backPlate.id`; `siteChargers.json` does not carry it at all.
 *
 * Authentication: either `EASEE_ACCESS_TOKEN`, or `EASEE_TECHNICAL_USERNAME` +
 * `EASEE_TECHNICAL_PASSWORD`, in which case the script logs in itself.
 *
 * Flags:
 *   --out <path>          output file (default ./parking-lots.real.json)
 *   --exclude <ids>       comma-separated Easee user ids to skip when picking the first user —
 *                         site admins and technical accounts are permitted on *every* charger and
 *                         would otherwise be picked as the owner of all of them
 *   --line <L1|L2>        fallback line for chargers `site.json` does not place (default L1)
 *   --phases <1|3>        default 3
 *   --max-current <amps>  default 16
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

type SiteCharger = { id: string; name: string }
type SiteUsers = { siteUsers: { userId: number; name: string; email: string }[] }
type Permission = { userId: number; name: string; email: string }
type Site = {
  circuits: {
    circuitPanelId: number
    panelName?: string
    chargers: { id: string; backPlate?: { id?: string } }[]
  }[]
}
type ParkingLot = {
  lotNumber: string
  chargerId: string
  serialNumber: string
  easeeUserId: string
  line: 'L1' | 'L2'
  phases: 1 | 3
  maxCurrentA: number
}

const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url))
const baseUrl = process.env['EASEE_API_BASE'] ?? 'https://api.easee.com'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function accessToken(): Promise<string> {
  const existing = process.env['EASEE_ACCESS_TOKEN']
  if (existing) return existing

  const userName = process.env['EASEE_TECHNICAL_USERNAME']
  const password = process.env['EASEE_TECHNICAL_PASSWORD']
  if (!userName || !password) {
    throw new Error(
      'set EASEE_ACCESS_TOKEN, or EASEE_TECHNICAL_USERNAME and EASEE_TECHNICAL_PASSWORD',
    )
  }

  const response = await fetch(`${baseUrl}/api/accounts/login`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ userName, password }),
  })
  if (!response.ok) {
    throw new Error(`login failed: ${response.status} ${await response.text()}`)
  }
  const token = (await response.json()) as { accessToken?: string }
  if (!token.accessToken) throw new Error('login response carried no accessToken')
  return token.accessToken
}

/** One retry on the transient statuses; anything else is a hard failure worth stopping for. */
async function permissions(chargerId: string, token: string): Promise<Permission[]> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/api/chargers/${encodeURIComponent(chargerId)}/permission`,
      { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
    )
    if (response.ok) return (await response.json()) as Permission[]
    if (attempt < 2 && (response.status === 429 || response.status >= 500)) {
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)))
      continue
    }
    throw new Error(`permission for ${chargerId} failed: ${response.status} ${await response.text()}`)
  }
}

/** Firestore document ids may not contain `/`, and the lot number *is* the document id. */
function toLotNumber(chargerName: string): string {
  return chargerName.trim().replace(/\//g, '-')
}

/**
 * chargerId → supply line and serial number, read off the site's circuits.
 *
 * `circuitPanelId` numbers the panel a circuit hangs off, and the model only knows two lines, so
 * anything other than panel 1 or 2 is refused here rather than written out as a line the optimizer
 * cannot group by. The serial number is the charger's back plate id — the id the observations
 * endpoint is addressed by, which `siteChargers.json` does not carry.
 */
function chargerFactsFromSite(site: Site): Map<string, { line: 'L1' | 'L2'; serialNumber: string }> {
  const facts = new Map<string, { line: 'L1' | 'L2'; serialNumber: string }>()
  for (const circuit of site.circuits ?? []) {
    const line = `L${circuit.circuitPanelId}`
    if (line !== 'L1' && line !== 'L2') {
      throw new Error(
        `circuit panel ${circuit.circuitPanelId} (${circuit.panelName ?? 'unnamed'}) maps to ` +
          `${line}, but the model only has L1 and L2 — map it by hand`,
      )
    }
    for (const charger of circuit.chargers ?? []) {
      const serialNumber = charger.backPlate?.id
      if (!serialNumber) {
        throw new Error(`charger ${charger.id} has no backPlate.id in site.json`)
      }
      facts.set(charger.id, { line, serialNumber })
    }
  }
  return facts
}

async function main(): Promise<void> {
  const out = flag('out') ?? here('parking-lots.real.json')
  const fallbackLine = (flag('line') ?? 'L1') as 'L1' | 'L2'
  const phases = Number(flag('phases') ?? 3) as 1 | 3
  const maxCurrentA = Number(flag('max-current') ?? 16)
  const excluded = new Set(
    (flag('exclude') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  )

  const chargers = JSON.parse(readFileSync(here('siteChargers.json'), 'utf8')) as SiteCharger[]
  const users = JSON.parse(readFileSync(here('siteUsers.json'), 'utf8')) as SiteUsers
  const site = JSON.parse(readFileSync(here('site.json'), 'utf8')) as Site
  const knownUsers = new Map(users.siteUsers.map((user) => [String(user.userId), user]))
  const facts = chargerFactsFromSite(site)

  const token = await accessToken()
  const lots: ParkingLot[] = []
  const orphaned: string[] = []
  const unplaced: string[] = []

  for (const charger of chargers) {
    const permitted = await permissions(charger.id, token)
    const owner = permitted.find((user) => !excluded.has(String(user.userId)))
    const easeeUserId = owner ? String(owner.userId) : ''
    const lotNumber = toLotNumber(charger.name)

    if (!owner) orphaned.push(lotNumber)
    else if (!knownUsers.has(easeeUserId)) {
      console.warn(`${lotNumber}: user ${easeeUserId} (${owner.name}) is not in siteUsers.json`)
    }

    // A charger on no circuit has neither a line nor a back plate to read, so it falls back to the
    // charger id as its serial and to `--line`; both are reported at the end.
    const fact = facts.get(charger.id)
    if (!fact) unplaced.push(lotNumber)
    const line = fact?.line ?? fallbackLine
    const serialNumber = fact?.serialNumber ?? charger.id

    lots.push({
      lotNumber,
      chargerId: charger.id,
      serialNumber,
      easeeUserId,
      line,
      phases,
      maxCurrentA,
    })
    console.log(
      `${lotNumber.padEnd(8)} ${charger.id}  ${serialNumber.padEnd(14)} ${line.padEnd(2)}` +
        `  ${easeeUserId || '(no user)'} ${knownUsers.get(easeeUserId)?.name ?? owner?.name ?? ''}`,
    )
  }

  lots.sort((a, b) => a.lotNumber.localeCompare(b.lotNumber))
  writeFileSync(out, `${JSON.stringify(lots, null, 2)}\n`)

  // Two chargers sharing a user is legitimate (one household, two lots); it is also what an
  // un-excluded site admin looks like, so it is worth surfacing before this is seeded.
  const perUser = new Map<string, string[]>()
  for (const lot of lots) {
    if (lot.easeeUserId) perUser.set(lot.easeeUserId, [...(perUser.get(lot.easeeUserId) ?? []), lot.lotNumber])
  }
  for (const [userId, lotNumbers] of perUser) {
    if (lotNumbers.length > 1) {
      console.warn(
        `user ${userId} (${knownUsers.get(userId)?.name ?? 'unknown'}) owns ${lotNumbers.length} lots: ${lotNumbers.join(', ')}`,
      )
    }
  }

  const perLine = new Map<string, number>()
  for (const lot of lots) perLine.set(lot.line, (perLine.get(lot.line) ?? 0) + 1)

  console.log(`\nwrote ${lots.length} parking lots to ${out}`)
  console.log(`lines: ${[...perLine].map(([l, n]) => `${l}=${n}`).join(' ')}`)
  if (orphaned.length > 0) console.log(`orphaned (no user): ${orphaned.join(', ')}`)
  if (unplaced.length > 0) {
    console.warn(
      `not on any circuit in site.json — line defaulted to ${fallbackLine} and the charger id ` +
        `used as the serial number: ${unplaced.join(', ')}`,
    )
  }
  console.log(
    `phases/maxCurrentA are defaults (${phases}/${maxCurrentA}A) — the Easee API does not report ` +
      'them, so fix them by hand before seeding.',
  )
}

main().catch((error: unknown) => {
  console.error('createParkingLots failed:', error)
  process.exitCode = 1
})
