import { createHmac, createSign, generateKeyPairSync } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { EaseeTokenVerifier } from '../src/middleware/easeeAuth.js'

/**
 * T043 — the auth middleware's job is to be un-forgeable, so most of these tests are attacks.
 */

const ISSUER = 'https://auth.easee.com/realms/easee'
const AUDIENCE = 'easee'
const JWKS_URL = 'https://auth.easee.com/realms/easee/protocol/openid-connect/certs'
const NOW_MS = Date.parse('2026-08-14T14:35:00Z')
const NOW_SECONDS = Math.floor(NOW_MS / 1000)

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url')

function jwk(publicKey: KeyObject, kid: string, alg = 'RS256', use = 'sig') {
  const exported = publicKey.export({ format: 'jwk' }) as { n: string; e: string }
  return { kid, kty: 'RSA', alg, use, n: exported.n, e: exported.e }
}

function signRs256(privateKey: KeyObject, header: object, payload: object): string {
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey)
  return `${signingInput}.${signature.toString('base64url')}`
}

const realKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const attackerKeys = generateKeyPairSync('rsa', { modulusLength: 2048 })
const REAL_KID = 'eqRJ08F11AB-xAhg6sRmwqHNOw9eKOInbZIZHJjh9W8'

const validClaims = {
  iss: ISSUER,
  aud: ['account', AUDIENCE],
  azp: AUDIENCE,
  exp: NOW_SECONDS + 3600,
  iat: NOW_SECONDS,
  UserId: '12345',
  email: 'user@example.com',
}

type FetchLog = { calls: number }

function makeVerifier(): { verifier: EaseeTokenVerifier; log: FetchLog } {
  const log: FetchLog = { calls: 0 }
  const jwks = { keys: [jwk(realKeys.publicKey, REAL_KID)] }
  const verifier = new EaseeTokenVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUrl: JWKS_URL,
    now: () => NOW_MS,
    fetchImpl: (async () => {
      log.calls += 1
      return new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'max-age=600' },
      })
    }) as typeof globalThis.fetch,
  })
  return { verifier, log }
}

describe('EaseeTokenVerifier — the happy path', () => {
  it('accepts a token signed by the published key and extracts UserId (FR-003)', async () => {
    const { verifier } = makeVerifier()
    const token = signRs256(
      realKeys.privateKey,
      { alg: 'RS256', typ: 'JWT', kid: REAL_KID },
      validClaims,
    )

    const result = await verifier.verify(token)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims.userId).toBe('12345')
      expect(result.claims.email).toBe('user@example.com')
    }
  })

  it('never calls Easee on the request path once the keys are cached', async () => {
    const { verifier, log } = makeVerifier()
    const token = signRs256(realKeys.privateKey, { alg: 'RS256', kid: REAL_KID }, validClaims)

    await verifier.verify(token)
    await verifier.verify(token)
    await verifier.verify(token)

    expect(log.calls).toBe(1)
  })
})

describe('EaseeTokenVerifier — forgery attempts', () => {
  let verifier: EaseeTokenVerifier

  beforeEach(() => {
    verifier = makeVerifier().verifier
  })

  it('rejects a token re-signed with an attacker key whose kid matches a real one', async () => {
    const forged = signRs256(attackerKeys.privateKey, { alg: 'RS256', kid: REAL_KID }, validClaims)

    const result = await verifier.verify(forged)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('token_invalid')
      expect(result.message).toContain('signature')
    }
  })

  it('rejects alg: none', async () => {
    const header = b64url(JSON.stringify({ alg: 'none', kid: REAL_KID }))
    const payload = b64url(JSON.stringify(validClaims))

    const withEmptySignature = await verifier.verify(`${header}.${payload}.`)
    expect(withEmptySignature.ok).toBe(false)

    const withGarbageSignature = await verifier.verify(`${header}.${payload}.${b64url('anything')}`)
    expect(withGarbageSignature.ok).toBe(false)
  })

  it('rejects an HS256 token forged with the RSA public key as the HMAC secret', async () => {
    // The classic algorithm-confusion attack: the public key is, by definition, public.
    const publicPem = realKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const header = b64url(JSON.stringify({ alg: 'HS256', kid: REAL_KID }))
    const payload = b64url(JSON.stringify(validClaims))
    const mac = createHmac('sha256', publicPem).update(`${header}.${payload}`).digest('base64url')

    const result = await verifier.verify(`${header}.${payload}.${mac}`)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('token_invalid')
  })

  it('rejects a token from another issuer', async () => {
    const token = signRs256(
      realKeys.privateKey,
      { alg: 'RS256', kid: REAL_KID },
      { ...validClaims, iss: 'https://auth.easee.com/realms/master' },
    )

    const result = await verifier.verify(token)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('issuer')
  })

  it('rejects a token whose audience does not include easee', async () => {
    const token = signRs256(
      realKeys.privateKey,
      { alg: 'RS256', kid: REAL_KID },
      { ...validClaims, aud: ['account'] },
    )

    const result = await verifier.verify(token)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('audience')
  })

  it('rejects an expired token with token_expired so the client knows to refresh', async () => {
    const token = signRs256(
      realKeys.privateKey,
      { alg: 'RS256', kid: REAL_KID },
      { ...validClaims, exp: NOW_SECONDS - 60 },
    )

    const result = await verifier.verify(token)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('token_expired')
  })

  it('rejects a token with no UserId claim', async () => {
    const { UserId: _dropped, ...withoutUserId } = validClaims
    const token = signRs256(realKeys.privateKey, { alg: 'RS256', kid: REAL_KID }, withoutUserId)

    const result = await verifier.verify(token)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('UserId')
  })
})

describe('EaseeTokenVerifier — JWKS fetch amplification', () => {
  it('re-fetches at most once per rate-limit window for unknown kids', async () => {
    const { verifier, log } = makeVerifier()
    const forgedKid = signRs256(
      attackerKeys.privateKey,
      { alg: 'RS256', kid: 'made-up-kid' },
      validClaims,
    )

    for (let i = 0; i < 20; i += 1) {
      const result = await verifier.verify(forgedKid)
      expect(result.ok).toBe(false)
    }

    // One fetch for the cold cache; the unknown kid does not buy the attacker twenty more.
    expect(log.calls).toBe(1)
  })
})

describe('EaseeTokenVerifier — against the real recorded JWKS (spike O2)', () => {
  const jwksPath = fileURLToPath(
    new URL('../../../fixtures/providers/easee/auth-jwks.json', import.meta.url),
  )
  const recorded = JSON.parse(readFileSync(jwksPath, 'utf8')) as {
    keys: { kid: string; use?: string; alg?: string }[]
  }

  it('contains the RS256 signing key the spike verified a real token against', () => {
    const signing = recorded.keys.find((k) => k.kid === REAL_KID)
    expect(signing?.alg).toBe('RS256')
    expect(signing?.use).toBe('sig')
  })

  it('refuses to verify a signature with the realm encryption key', async () => {
    const encryptionKey = recorded.keys.find((k) => k.use === 'enc')
    expect(encryptionKey).toBeDefined()

    const verifier = new EaseeTokenVerifier({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUrl: JWKS_URL,
      now: () => NOW_MS,
      fetchImpl: (async () => new Response('{}', { status: 500 })) as typeof globalThis.fetch,
    })
    verifier.primeFromJwks(recorded)

    const token = signRs256(
      attackerKeys.privateKey,
      { alg: 'RS256', kid: encryptionKey?.kid },
      validClaims,
    )
    const result = await verifier.verify(token)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('not a signing key')
  })
})
