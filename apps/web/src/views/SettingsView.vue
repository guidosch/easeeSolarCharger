<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '../stores/session'

/**
 * Account and deletion (T126, FR-048).
 *
 * The confirmation is explicit and the wording states plainly that the deletion is permanent —
 * there is no soft flag behind it and nothing to undo.
 */
const session = useSessionStore()
const router = useRouter()

const confirming = ref(false)
const deleting = ref(false)
const problem = ref<string | null>(null)

function signOut(): void {
  session.signOut()
  void router.push('/login')
}

async function deleteEverything(): Promise<void> {
  deleting.value = true
  problem.value = null
  try {
    await session.request('/api/me', {
      method: 'DELETE',
      body: JSON.stringify({ confirm: 'DELETE' }),
    })
    session.signOut()
    await router.push('/login')
  } catch {
    problem.value = 'Could not delete your data. Try again.'
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <h1>Settings</h1>

  <div class="card">
    <h2>Account</h2>
    <p class="muted">
      Signed in as {{ session.session?.email ?? session.session?.userId }}. This system stores only
      your Easee user reference, your targets and your last five sessions.
    </p>
    <button class="secondary" @click="signOut">Sign out</button>
  </div>

  <div class="card">
    <h2>Delete all my data</h2>
    <p class="muted">
      This removes your targets, sessions, history and fairness record permanently. It cannot be
      undone. Any open target and any active "charge now" override on your chargers are cancelled as
      part of the deletion. Your parking lot stays assigned to you, and you can sign in again
      immediately as a new user.
    </p>

    <p v-if="problem" class="warning">{{ problem }}</p>

    <button v-if="!confirming" class="secondary" @click="confirming = true">
      Delete all my data
    </button>
    <template v-else>
      <p class="warning">Are you sure? This is permanent.</p>
      <button :disabled="deleting" @click="deleteEverything">
        {{ deleting ? 'Deleting…' : 'Yes, delete everything' }}
      </button>
      <button class="secondary" style="margin-top: 0.5rem" @click="confirming = false">
        Keep my data
      </button>
    </template>
  </div>
</template>
