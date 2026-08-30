import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { LoginResponse, MappedCharger } from '@app/shared'

/**
 * The session store (T065).
 *
 * Tokens are Easee's own, opaque to this client. The one behaviour that matters here is the
 * response to `401 token_expired`: refresh once and retry, so a user whose hour-long token lapses
 * mid-session is not thrown back to the login screen for no reason (spec edge case).
 */
const STORAGE_KEY = 'solar-charging-session'

type StoredSession = {
  accessToken: string
  refreshToken: string
  userId: string
  email?: string
  chargers: MappedCharger[]
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly earliestFeasibleDeadline?: string,
  ) {
    super(message)
  }
}

export const useSessionStore = defineStore('session', () => {
  const session = ref<StoredSession | null>(restore())
  const signingIn = ref(false)
  const error = ref<string | null>(null)

  function restore(): StoredSession | null {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? (JSON.parse(raw) as StoredSession) : null
    } catch {
      return null
    }
  }

  function persist(value: StoredSession | null): void {
    session.value = value
    if (value) localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    else localStorage.removeItem(STORAGE_KEY)
  }

  function adopt(response: LoginResponse): void {
    persist({
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      userId: response.user.userId,
      ...(response.user.email ? { email: response.user.email } : {}),
      chargers: response.chargers,
    })
  }

  async function signIn(userName: string, password: string): Promise<void> {
    signingIn.value = true
    error.value = null
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userName, password }),
      })
      const body: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        const code = (body as { error?: string } | null)?.error ?? 'unknown'
        error.value =
          code === 'no_charger_mapped'
            ? 'Ihnen ist keine Ladestation zugewiesen. Bitten Sie den Betreiber, Ihren Parkplatz zuzuordnen.'
            : 'Anmeldung fehlgeschlagen. Bitte prüfen Sie Ihre Easee-Kontodaten.'
        return
      }
      adopt(body as LoginResponse)
    } catch {
      error.value = 'Der Dienst ist nicht erreichbar.'
    } finally {
      signingIn.value = false
    }
  }

  function signOut(): void {
    persist(null)
  }

  async function refresh(): Promise<boolean> {
    const current = session.value
    if (!current) return false
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${current.accessToken}`,
      },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    })
    if (!response.ok) {
      persist(null)
      return false
    }
    adopt((await response.json()) as LoginResponse)
    return true
  }

  /** Every authenticated call goes through here, so the refresh-once rule lives in one place. */
  async function request<T>(path: string, init: RequestInit = {}, retrying = false): Promise<T> {
    const current = session.value
    if (!current) throw new ApiError(401, 'token_invalid', 'not signed in')

    const response = await fetch(path, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${current.accessToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    })

    if (response.status === 204) return undefined as T
    const body: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      const failure = body as {
        error?: string
        message?: string
        earliestFeasibleDeadline?: string
      } | null
      const code = failure?.error ?? 'unknown'
      if (code === 'token_expired' && !retrying && (await refresh())) {
        return request<T>(path, init, true)
      }
      throw new ApiError(
        response.status,
        code,
        failure?.message ?? code,
        failure?.earliestFeasibleDeadline,
      )
    }

    return body as T
  }

  return { session, signingIn, error, signIn, signOut, refresh, request }
})
