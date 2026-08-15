<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from './stores/session'

const session = useSessionStore()
const route = useRoute()
const showNav = computed(() => Boolean(session.session) && route.name !== 'login')
</script>

<template>
  <nav v-if="showNav">
    <router-link to="/">Chargers</router-link>
    <router-link to="/history">History</router-link>
    <router-link to="/settings">Settings</router-link>
  </nav>

  <router-view />
</template>
