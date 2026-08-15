import { ref } from 'vue'

/**
 * The admin client.
 *
 * Basic auth, held in memory only. Deliberately not persisted: the credential is shared, and a
 * shared credential sitting in `localStorage` on an operator's desktop is a worse trade than
 * typing it again after a reload.
 */
const credential = ref<string | null>(null)

export function signIn(username: string, password: string): void {
  credential.value = btoa(`${username}:${password}`)
}

export function signOut(): void {
  credential.value = null
}

export function isSignedIn(): boolean {
  return credential.value !== null
}

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function adminFetch<T>(path: string): Promise<T> {
  if (!credential.value) throw new AdminApiError(401, 'not signed in')

  const response = await fetch(`/api/admin${path}`, {
    headers: { authorization: `Basic ${credential.value}` },
  })

  if (response.status === 401) {
    credential.value = null
    throw new AdminApiError(401, 'the operator credential was rejected')
  }
  if (!response.ok) {
    throw new AdminApiError(response.status, `request failed with ${response.status}`)
  }
  return (await response.json()) as T
}

export { credential }
