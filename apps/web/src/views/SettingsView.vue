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
      // The confirmation token is part of the API contract, not something the user reads.
      body: JSON.stringify({ confirm: 'DELETE' }),
    })
    session.signOut()
    await router.push('/login')
  } catch {
    problem.value = 'Ihre Daten konnten nicht gelöscht werden. Bitte versuchen Sie es erneut.'
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <h1>Einstellungen</h1>

  <div class="card">
    <h2>Konto</h2>
    <p class="muted">
      Angemeldet als {{ session.session?.email ?? session.session?.userId }}. Dieses System
      speichert nur Ihre Easee-Benutzerkennung, Ihre Ladeziele und Ihre letzten fünf Ladevorgänge.
    </p>
    <button class="secondary" @click="signOut">Abmelden</button>
  </div>

  <div class="card">
    <h2>Alle meine Daten löschen</h2>
    <p class="muted">
      Damit werden Ihre Ladeziele, Ihre Ladevorgänge, Ihr Verlauf und Ihr Fairness-Eintrag dauerhaft
      entfernt. Das lässt sich nicht rückgängig machen. Ein offenes Ladeziel und ein aktives «Jetzt
      laden» an Ihren Ladestationen werden im Rahmen der Löschung abgebrochen. Ihr Parkplatz bleibt
      Ihnen zugewiesen, und Sie können sich sofort wieder als neue Benutzerin oder neuer Benutzer
      anmelden.
    </p>

    <p v-if="problem" class="warning">{{ problem }}</p>

    <button v-if="!confirming" class="secondary" @click="confirming = true">
      Alle meine Daten löschen
    </button>
    <template v-else>
      <p class="warning">Sind Sie sicher? Das ist endgültig.</p>
      <button :disabled="deleting" @click="deleteEverything">
        {{ deleting ? 'Wird gelöscht…' : 'Ja, alles löschen' }}
      </button>
      <button class="secondary" style="margin-top: 0.5rem" @click="confirming = false">
        Daten behalten
      </button>
    </template>
  </div>
</template>
