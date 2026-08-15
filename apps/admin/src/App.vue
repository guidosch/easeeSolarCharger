<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isSignedIn, signOut } from './api'

const route = useRoute()
const router = useRouter()
const showNav = computed(() => route.name !== 'signin' && isSignedIn())

function leave(): void {
  signOut()
  void router.push('/signin')
}
</script>

<template>
  <header>
    <h1>Solar charging — operator</h1>
    <nav v-if="showNav">
      <router-link to="/cycles">Cycles</router-link>
      <router-link to="/chargers">Chargers</router-link>
      <router-link to="/providers">Providers</router-link>
      <button class="link" @click="leave">Sign out</button>
    </nav>
  </header>

  <main>
    <router-view />
  </main>
</template>
