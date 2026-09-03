<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { applyUpdate, updateAvailable } from './pwa'
import { useSessionStore } from './stores/session'

const session = useSessionStore()
const route = useRoute()
const showNav = computed(() => Boolean(session.session) && route.name !== 'login')
</script>

<template>
  <!-- Shown even on the login screen: an out-of-date app is worth replacing before signing in. -->
  <div v-if="updateAvailable" class="update">
    <span>Neue Version verfügbar.</span>
    <button type="button" @click="applyUpdate">Aktualisieren</button>
  </div>

  <nav v-if="showNav">
    <router-link to="/">Ladestationen</router-link>
    <router-link to="/history">Verlauf</router-link>
    <router-link to="/settings">Einstellungen</router-link>
  </nav>

  <router-view />
</template>
