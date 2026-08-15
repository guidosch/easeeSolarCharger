import { z } from 'zod'
import type { BudgetLimiter } from '../http/budget.js'
import type { HttpClient } from '../http/client.js'
import type { Result } from '../http/errors.js'
import { err, ok } from '../http/errors.js'

/**
 * The SolarEdge client (T074, research R2).
 *
 * `currentPowerFlow` is a single call that already contains the net grid position — precisely the
 * quantity the optimizer needs — instead of two series that would cost twice the budget and carry a
 * timestamp skew between them.
 *
 * **Direction lives in `connections`, not in the sign of `currentPower`.** Every value in the
 * payload is a positive magnitude; whether the site is importing or exporting is expressed by
 * whether a connection points *to* the grid or *from* it. Reading the magnitude without the
 * direction inverts the surplus signal, which is the single most damaging bug available in this
 * integration — so it is the one the contract test asserts in both directions.
 */

const PowerNode = z.object({
  status: z.string().optional(),
  currentPower: z.number(),
})

const Connection = z.object({ from: z.string(), to: z.string() })

const CurrentPowerFlow = z.object({
  siteCurrentPowerFlow: z.object({
    unit: z.string().optional(),
    connections: z.array(Connection),
    GRID: PowerNode.optional(),
    LOAD: PowerNode.optional(),
    PV: PowerNode.optional(),
  }),
})

/** The domain model. `gridExportKw` is negative on import. */
export type SitePower = {
  gridExportKw: number
  loadKw: number
  pvKw: number
  observedAt: string
}

export function parseCurrentPowerFlow(payload: unknown, observedAt: string): Result<SitePower> {
  const parsed = CurrentPowerFlow.safeParse(payload)
  if (!parsed.success) {
    return err({
      kind: 'malformed',
      provider: 'solaredge',
      message: `currentPowerFlow did not match the contract: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
    })
  }

  const flow = parsed.data.siteCurrentPowerFlow
  if (!flow.GRID) {
    // Open item O1: LOAD and GRID are only present when the site has consumption metering. Without
    // GRID the surplus formula has no input at all, and inventing one would be worse than failing.
    return err({
      kind: 'malformed',
      provider: 'solaredge',
      message:
        'currentPowerFlow carried no GRID element — the site may have no consumption metering ' +
        '(research R2, open item O1)',
    })
  }

  const exporting = flow.connections.some((c) => c.to.toUpperCase() === 'GRID')
  const importing = flow.connections.some((c) => c.from.toUpperCase() === 'GRID')
  if (!exporting && !importing) {
    // Neither direction stated: the magnitude alone is unusable, and guessing a sign here is
    // exactly the bug this parser exists to prevent.
    return err({
      kind: 'malformed',
      provider: 'solaredge',
      message: 'no connection to or from GRID — the flow direction is unstated',
    })
  }

  const magnitude = Math.abs(flow.GRID.currentPower)
  return ok({
    gridExportKw: exporting ? magnitude : -magnitude,
    loadKw: flow.LOAD?.currentPower ?? 0,
    pvKw: flow.PV?.currentPower ?? 0,
    observedAt,
  })
}

export class SolarEdgeClient {
  constructor(
    private readonly http: HttpClient,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly siteId: string,
    private readonly budget: BudgetLimiter,
  ) {}

  async currentPowerFlow(observedAt: string): Promise<Result<SitePower>> {
    return this.http.request<SitePower>(
      {
        provider: 'solaredge',
        url: `${this.baseUrl}/site/${encodeURIComponent(this.siteId)}/currentPowerFlow?api_key=${encodeURIComponent(this.apiKey)}`,
        timeoutMs: 10_000,
        parse: (payload) => parseCurrentPowerFlow(payload, observedAt),
      },
      this.budget,
    )
  }

  remainingToday(nowMs: number): number {
    return this.budget.remainingToday(nowMs)
  }
}
