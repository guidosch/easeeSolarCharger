<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { STATE_LABELS, stateClass, useChargersStore } from '../stores/chargers'

/**
 * Charger selection (T131, US8).
 *
 * A user mapped to exactly one parking lot never sees this screen — they are routed straight to
 * their charger (US8 scenario 3). The list only earns its place when there is a choice to make.
 */
const chargers = useChargersStore()
const router = useRouter()

function skipWhenOnlyOne(): void {
  const only = chargers.chargers.length === 1 ? chargers.chargers[0] : undefined
  if (only) void router.replace(`/chargers/${only.lotNumber}`)
}

onMounted(async () => {
  await chargers.load()
  skipWhenOnlyOne()
})

watch(() => chargers.chargers.length, skipWhenOnlyOne)
</script>

<template>
  <h1>Ihre Ladestationen</h1>

  <p v-if="chargers.error" class="card warning">{{ chargers.error }}</p>
  <p v-if="chargers.loading" class="muted">Wird geladen…</p>

  <router-link
    v-for="charger in chargers.chargers"
    :key="charger.lotNumber"
    :to="`/chargers/${charger.lotNumber}`"
    style="text-decoration: none; color: inherit"
  >
    <div class="card">
      <div class="row">
        <h2 style="margin: 0">Parkplatz {{ charger.lotNumber }}</h2>
        <span :class="stateClass(charger.state)">{{ STATE_LABELS[charger.state] }}</span>
      </div>
      <p v-if="charger.target" class="muted" style="margin: 0.5rem 0 0">
        noch {{ charger.target.remainingKwh.toFixed(1) }} kWh von {{ charger.target.energyKwh }} kWh
      </p>
      <p v-else class="muted" style="margin: 0.5rem 0 0">Kein Ladeziel gesetzt</p>
    </div>
  </router-link>
</template>
