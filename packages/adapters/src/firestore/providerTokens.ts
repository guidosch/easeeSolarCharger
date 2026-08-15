import type { Firestore } from 'firebase-admin/firestore'
import type { CachedToken, TokenStore } from '../easee/auth.js'
import { COLLECTIONS } from './db.js'
import type { ProviderTokenDoc } from './types.js'

const EASEE_TECHNICAL = 'easeeTechnical'

/**
 * The optimizer's technical-account token, cached so cold starts do not each re-login.
 *
 * The token *values* live here rather than in Secret Manager because they rotate hourly; the
 * **credentials** that mint them stay in Secret Manager (Principle V).
 */
export class ProviderTokensRepo implements TokenStore {
  constructor(private readonly db: Firestore) {}

  private ref() {
    return this.db.collection(COLLECTIONS.providerTokens).doc(EASEE_TECHNICAL)
  }

  async read(): Promise<CachedToken | null> {
    const doc = await this.ref().get()
    if (!doc.exists) return null
    const data = doc.data() as ProviderTokenDoc
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresAt: data.expiresAt,
    }
  }

  async write(token: CachedToken): Promise<void> {
    const doc: ProviderTokenDoc = { ...token }
    await this.ref().set(doc)
  }
}
