import { createSign, generateKeyPairSync } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/**
 * Test-only token minting.
 *
 * Integration tests need a *genuinely valid* token rather than a stubbed verifier, so the auth
 * path is exercised end to end: a route that accidentally skipped verification would still pass a
 * test that mocked it away.
 */
export const TEST_ISSUER = 'https://auth.easee.com/realms/easee'
export const TEST_AUDIENCE = 'easee'
export const TEST_KID = 'test-signing-key'

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 })

export function testJwks(): { keys: Record<string, unknown>[] } {
  const exported = keys.publicKey.export({ format: 'jwk' }) as { n: string; e: string }
  return {
    keys: [{ kid: TEST_KID, kty: 'RSA', alg: 'RS256', use: 'sig', n: exported.n, e: exported.e }],
  }
}

export function mintToken(
  userId: string,
  options: { email?: string; expiresAtSeconds?: number; issuer?: string } = {},
): string {
  const header = { alg: 'RS256', typ: 'JWT', kid: TEST_KID }
  const payload = {
    iss: options.issuer ?? TEST_ISSUER,
    aud: ['account', TEST_AUDIENCE],
    exp: options.expiresAtSeconds ?? Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    UserId: userId,
    email: options.email ?? `${userId}@example.com`,
  }
  return sign(keys.privateKey, header, payload)
}

function sign(privateKey: KeyObject, header: object, payload: object): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const signingInput = `${b64(header)}.${b64(payload)}`
  return `${signingInput}.${createSign('RSA-SHA256').update(signingInput).sign(privateKey).toString('base64url')}`
}

export function bearer(userId: string): Record<string, string> {
  return { authorization: `Bearer ${mintToken(userId)}` }
}
