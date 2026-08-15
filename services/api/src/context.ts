import { randomUUID } from 'node:crypto'
import {
  BudgetLimiter,
  ChargerEventsRepo,
  ChargersRepo,
  CyclesRepo,
  EaseeAuthClient,
  FairnessRepo,
  HttpClient,
  LeaseRepo,
  PROVIDER_BUDGETS,
  ParkingLotsRepo,
  SessionsRepo,
  TargetsRepo,
  UsersRepo,
  getDb,
} from '@app/adapters'
import { createLogger, loadEnv } from '@app/shared'
import type { AppEnv, Logger } from '@app/shared'
import type { Firestore } from 'firebase-admin/firestore'
import { EaseeTokenVerifier } from './middleware/easeeAuth.js'

export type ApiDeps = {
  env: AppEnv
  db: Firestore
  logger: Logger
  now: () => number
  verifier: EaseeTokenVerifier
  easeeAuth: EaseeAuthClient
  repos: {
    parkingLots: ParkingLotsRepo
    chargers: ChargersRepo
    users: UsersRepo
    targets: TargetsRepo
    sessions: SessionsRepo
    cycles: CyclesRepo
    events: ChargerEventsRepo
    fairness: FairnessRepo
    lease: LeaseRepo
  }
}

export type BuildApiOptions = {
  env?: AppEnv
  db?: Firestore
  now?: () => number
  verifier?: EaseeTokenVerifier
  logger?: Logger
}

export function buildApiDeps(options: BuildApiOptions = {}): ApiDeps {
  const env = options.env ?? loadEnv()
  const now = options.now ?? (() => Date.now())
  const db = options.db ?? getDb(env.GOOGLE_CLOUD_PROJECT)
  const logger =
    options.logger ??
    createLogger({ component: 'api', correlationId: `api-${randomUUID().slice(0, 8)}` })

  const http = new HttpClient()
  const easeeBudget = new BudgetLimiter({
    provider: 'easee',
    dailyLimit: null,
    burst: PROVIDER_BUDGETS.easeeObservations,
    startedAtMs: now(),
  })

  return {
    env,
    db,
    logger,
    now,
    verifier:
      options.verifier ??
      new EaseeTokenVerifier({
        issuer: env.EASEE_ISSUER,
        audience: env.EASEE_AUDIENCE,
        jwksUrl: env.EASEE_JWKS_URL,
        now,
      }),
    easeeAuth: new EaseeAuthClient(http, env.EASEE_API_BASE, easeeBudget, now),
    repos: {
      parkingLots: new ParkingLotsRepo(db),
      chargers: new ChargersRepo(db),
      users: new UsersRepo(db),
      targets: new TargetsRepo(db),
      sessions: new SessionsRepo(db),
      cycles: new CyclesRepo(db),
      events: new ChargerEventsRepo(db),
      fairness: new FairnessRepo(db),
      lease: new LeaseRepo(db),
    },
  }
}
