<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '../stores/session'

// Sign-in uses the user's existing Easee account (FR-001); this system has no accounts of its own.
const session = useSessionStore()
const router = useRouter()

const userName = ref('')
const password = ref('')

async function submit(): Promise<void> {
  await session.signIn(userName.value, password.value)
  password.value = ''
  if (session.session) await router.push('/')
}
</script>

<template>
  <h1>Solarladen</h1>

  <form class="card" @submit.prevent="submit">
    <h2>Anmelden</h2>
    <p class="muted">
      Verwenden Sie Ihr <a href="https://portal.easee.com/" target="_blank" rel="noopener noreferrer">Easee-Konto</a>. Ihr Passwort wird nur an Easee weitergeleitet und nie
      gespeichert.
    </p>

    <label for="userName">E-Mail</label>
    <input id="userName" v-model="userName" type="email" autocomplete="username" required />

    <label for="password" style="margin-top: 0.75rem">Passwort</label>
    <input
      id="password"
      v-model="password"
      type="password"
      autocomplete="current-password"
      required
    />

    <p v-if="session.error" class="warning" style="margin-top: 1rem">{{ session.error }}</p>

    <button type="submit" :disabled="session.signingIn" style="margin-top: 1rem">
      {{ session.signingIn ? 'Anmeldung läuft…' : 'Anmelden' }}
    </button>
  </form>
</template>
