<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { signIn } from '../api'

// A single shared credential (constitution, Technology & Deployment Constraints). Admin reads carry
// no per-admin identity; charger commands remain attributed per Principle III.
const router = useRouter()
const username = ref('admin')
const password = ref('')

function submit(): void {
  signIn(username.value, password.value)
  void router.push('/cycles')
}
</script>

<template>
  <form class="signin" @submit.prevent="submit">
    <h2>Operator sign-in</h2>
    <label>Username <input v-model="username" autocomplete="username" /></label>
    <label
      >Password <input v-model="password" type="password" autocomplete="current-password"
    /></label>
    <button type="submit">Sign in</button>
  </form>
</template>
