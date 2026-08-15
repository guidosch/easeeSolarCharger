import { createPublicKey, constants as cryptoConstants, verify as cryptoVerify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/**
 * Local verification of Easee access tokens (T042, research R6 / spike O2).
 *
 * Easee's tokens are Keycloak-issued RS256 JWTs whose signing key is published at the realm JWKS,
 * so the constitution's "verify the JWT signature and expiry locally on every call" is satisfied
 * directly — there is no network round-trip on the request path and no window in which a revoked
 * token still works because a remote check was cached.
 *
 * The single most important line in this file is the one that takes `alg` from the **JWKS entry**
 * rather than from the token header. Trusting the header is the classic `alg: none` /
 * algorithm-confusion bug: an attacker sets `alg: HS256`, signs with the RSA *public* key as an
 * HMAC secret, and a naive verifier accepts it.
 */

export type JwksKey = {
  kid: string
  kty: string
  alg?: string
  use?: string
  n: string
  e: string
}

export type VerifiedClaims = {
  userId: string
  email: string | null
  expiresAt: number
  raw: Record<string, unknown>
}

export type VerifyFailureCode = 'token_expired' | 'token_invalid'

export type VerifyResult =
  { ok: true; claims: VerifiedClaims } | { ok: false; code: VerifyFailureCode; message: string }

export type VerifierOptions = {
  issuer: string
  audience: string
  jwksUrl: string
  fetchImpl?: typeof globalThis.fetch
  now?: () => number
  /** Floor on how often an unknown `kid` may trigger a JWKS fetch. */
  minRefetchIntervalMs?: number
  /** Fallback cache lifetime when the JWKS response carries no cache headers. */
  defaultCacheMs?: number
  /** Clock skew allowance on `exp`. */
  clockToleranceSeconds?: number
}

const DEFAULTS = {
  minRefetchIntervalMs: 60_000,
  defaultCacheMs: 10 * 60_000,
  clockToleranceSeconds: 30,
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maxAgeFrom(headers: Headers): number | null {
  const cacheControl = headers.get('cache-control')
  if (!cacheControl) return null
  const match = /max-age=(\d+)/i.exec(cacheControl)
  return match?.[1] ? Number(match[1]) * 1000 : null
}

export class EaseeTokenVerifier {
  private keys = new Map<string, JwksKey>()
  private publicKeys = new Map<string, KeyObject>()
  private cacheExpiresAtMs = 0
  private lastFetchAtMs = -Infinity
  private inFlight: Promise<void> | null = null

  private readonly fetchImpl: typeof globalThis.fetch
  private readonly now: () => number
  private readonly minRefetchIntervalMs: number
  private readonly defaultCacheMs: number
  private readonly clockToleranceSeconds: number

  constructor(private readonly options: VerifierOptions) {
    this.fetchImpl = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))
    this.now = options.now ?? (() => Date.now())
    this.minRefetchIntervalMs = options.minRefetchIntervalMs ?? DEFAULTS.minRefetchIntervalMs
    this.defaultCacheMs = options.defaultCacheMs ?? DEFAULTS.defaultCacheMs
    this.clockToleranceSeconds = options.clockToleranceSeconds ?? DEFAULTS.clockToleranceSeconds
  }

  /** Seeds the cache from a recording, so tests never reach the network. */
  primeFromJwks(jwks: unknown, cacheForMs = this.defaultCacheMs): void {
    this.ingest(jwks, cacheForMs)
  }

  private ingest(payload: unknown, cacheForMs: number): void {
    if (!isRecord(payload) || !Array.isArray(payload['keys'])) return
    for (const entry of payload['keys']) {
      if (!isRecord(entry)) continue
      const { kid, kty, n, e } = entry
      if (
        typeof kid !== 'string' ||
        typeof kty !== 'string' ||
        typeof n !== 'string' ||
        typeof e !== 'string'
      ) {
        continue
      }
      const key: JwksKey = {
        kid,
        kty,
        n,
        e,
        ...(typeof entry['alg'] === 'string' ? { alg: entry['alg'] } : {}),
        ...(typeof entry['use'] === 'string' ? { use: entry['use'] } : {}),
      }
      this.keys.set(kid, key)
      this.publicKeys.delete(kid)
    }
    this.cacheExpiresAtMs = this.now() + cacheForMs
  }

  /**
   * Fetches the JWKS at most once per `minRefetchIntervalMs`, and coalesces concurrent callers, so
   * a stream of tokens carrying forged `kid` values cannot turn this endpoint into a fetch
   * amplifier against Easee.
   */
  private async refresh(force: boolean): Promise<void> {
    const now = this.now()
    if (!force && now < this.cacheExpiresAtMs) return
    if (now - this.lastFetchAtMs < this.minRefetchIntervalMs) return
    if (this.inFlight) return this.inFlight

    this.lastFetchAtMs = now
    this.inFlight = (async () => {
      try {
        const response = await this.fetchImpl(this.options.jwksUrl, {
          headers: { accept: 'application/json' },
        })
        if (!response.ok) return
        const payload: unknown = await response.json()
        this.ingest(payload, maxAgeFrom(response.headers) ?? this.defaultCacheMs)
      } catch {
        // A JWKS fetch failure must not throw into the request path: it degrades to "unknown key",
        // which is a 401 the client can act on, not a 500.
      } finally {
        this.inFlight = null
      }
    })()
    return this.inFlight
  }

  private async keyFor(kid: string): Promise<JwksKey | null> {
    if (this.now() >= this.cacheExpiresAtMs) await this.refresh(false)
    const known = this.keys.get(kid)
    if (known) return known
    await this.refresh(true)
    return this.keys.get(kid) ?? null
  }

  private publicKeyFor(key: JwksKey): KeyObject {
    const cached = this.publicKeys.get(key.kid)
    if (cached) return cached
    const created = createPublicKey({
      key: { kty: 'RSA', n: key.n, e: key.e },
      format: 'jwk',
    })
    this.publicKeys.set(key.kid, created)
    return created
  }

  async verify(token: string): Promise<VerifyResult> {
    const parts = token.split('.')
    if (parts.length !== 3) {
      return { ok: false, code: 'token_invalid', message: 'token is not a three-part JWT' }
    }
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string]

    let header: unknown
    let payload: unknown
    try {
      header = decodeSegment(headerB64)
      payload = decodeSegment(payloadB64)
    } catch {
      return { ok: false, code: 'token_invalid', message: 'token segments are not base64url JSON' }
    }
    if (!isRecord(header) || !isRecord(payload)) {
      return { ok: false, code: 'token_invalid', message: 'token segments are not JSON objects' }
    }

    const kid = header['kid']
    if (typeof kid !== 'string') {
      return { ok: false, code: 'token_invalid', message: 'token header carries no kid' }
    }

    const key = await this.keyFor(kid)
    if (!key) {
      return {
        ok: false,
        code: 'token_invalid',
        message: `no published signing key for kid ${kid}`,
      }
    }
    if (key.use !== undefined && key.use !== 'sig') {
      // The realm also publishes an RSA-OAEP *encryption* key; it must never verify a signature.
      return { ok: false, code: 'token_invalid', message: `kid ${kid} is not a signing key` }
    }

    // The algorithm comes from the published key, never from the attacker-controlled header.
    const algorithm = key.alg ?? 'RS256'
    const verifyOptions = paddingFor(algorithm)
    if (!verifyOptions) {
      return {
        ok: false,
        code: 'token_invalid',
        message: `unsupported signing algorithm ${algorithm}`,
      }
    }

    let signatureValid = false
    try {
      signatureValid = cryptoVerify(
        'sha256',
        Buffer.from(`${headerB64}.${payloadB64}`),
        { key: this.publicKeyFor(key), ...verifyOptions },
        Buffer.from(signatureB64, 'base64url'),
      )
    } catch {
      signatureValid = false
    }
    if (!signatureValid) {
      return {
        ok: false,
        code: 'token_invalid',
        message: 'signature does not verify against the published key',
      }
    }

    if (payload['iss'] !== this.options.issuer) {
      return {
        ok: false,
        code: 'token_invalid',
        message: `unexpected issuer ${String(payload['iss'])}`,
      }
    }

    const audience = payload['aud']
    const audiences = Array.isArray(audience) ? audience : [audience]
    if (!audiences.includes(this.options.audience)) {
      return { ok: false, code: 'token_invalid', message: 'audience does not include this system' }
    }

    const exp = payload['exp']
    if (typeof exp !== 'number') {
      return { ok: false, code: 'token_invalid', message: 'token carries no exp' }
    }
    if (exp + this.clockToleranceSeconds < Math.floor(this.now() / 1000)) {
      return { ok: false, code: 'token_expired', message: 'token has expired' }
    }

    const userId = payload['UserId']
    if (typeof userId !== 'string' && typeof userId !== 'number') {
      return { ok: false, code: 'token_invalid', message: 'token carries no UserId claim' }
    }

    return {
      ok: true,
      claims: {
        userId: String(userId),
        email: typeof payload['email'] === 'string' ? payload['email'] : null,
        expiresAt: exp,
        raw: payload,
      },
    }
  }
}

function paddingFor(algorithm: string): { padding: number; saltLength?: number } | null {
  if (algorithm === 'RS256') return { padding: cryptoConstants.RSA_PKCS1_PADDING }
  if (algorithm === 'PS256') {
    return {
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    }
  }
  // Notably absent: HS256 and `none`. A token asking for either is rejected above, because the
  // algorithm is read from the JWKS entry and the realm publishes only RSA signing keys.
  return null
}
