<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { formatDeadline } from '../format'
import { STATE_LABELS, stateClass, useChargersStore } from '../stores/chargers'

/**
 * The live view of one charger (T066, T068, FR-035, FR-036).
 *
 * Two things are deliberately prominent: which *source* the car is charging from, and any expected
 * shortfall. Both exist so the optimization is visible rather than something that silently happens
 * to the user.
 */
const props = defineProps<{ lotNumber: string }>()
const chargers = useChargersStore()

const charger = computed(() => chargers.byLotNumber(props.lotNumber))
const target = computed(() => charger.value?.target ?? null)

const progressPercent = computed(() => {
  const t = target.value
  if (!t || t.energyKwh <= 0) return 0
  return Math.min(100, Math.round((t.deliveredKwh / t.energyKwh) * 100))
})

const deadlineLabel = computed(() => (target.value ? formatDeadline(target.value.deadline) : ''))

onMounted(() => {
  void chargers.load()
})
</script>

<template>
  <h1>Parkplatz {{ props.lotNumber }}</h1>

  <p v-if="chargers.error" class="card warning">{{ chargers.error }}</p>

  <!-- FR-034: an active override, and the fact that optimization is suspended, must both be visible. -->
  <div v-if="charger?.override.active" class="card warning">
    <h2 style="margin-top: 0">Lädt jetzt, Optimierung ausgesetzt</h2>
    <p style="margin: 0 0 0.75rem">
      Diese Ladestation lädt mit voller Leistung – unabhängig vom Solarüberschuss, von den
      Hochpreisfenstern und von Ihrem Termin. Sie schaltet sich am Ende des Ladevorgangs selbst
      wieder ab.
    </p>
    <button class="secondary" @click="chargers.setOverride(props.lotNumber, false)">
      Optimiertes Laden fortsetzen
    </button>
  </div>

  <div v-if="charger" class="card">
    <span :class="stateClass(charger.state)">{{ STATE_LABELS[charger.state] }}</span>

    <div class="row" style="margin-top: 0.75rem">
      <span class="muted">Aktueller Ladestrom</span>
      <strong>{{ charger.deliveredCurrentA.toFixed(1) }} A</strong>
    </div>
    <p class="muted" style="margin: 0">
      Von der Ladestation zurückgemeldet – der Wert zeigt also, was das Lastmanagement des Gebäudes
      tatsächlich freigibt.
    </p>

    <p v-if="charger.state === 'waiting_for_surplus'" class="muted" style="margin: 0.75rem 0 0">
      Ihr Auto ist angesteckt und bereit. Das System wartet auf genügend Solarüberschuss, um ohne
      Netzbezug zu laden – später lädt es aus dem Netz, wenn Ihr Termin es verlangt.
    </p>
  </div>

  <div v-if="charger && target" class="card">
    <h2>{{ target.energyKwh }} kWh bis {{ deadlineLabel }}</h2>

    <div class="bar"><span :style="{ width: `${progressPercent}%` }" /></div>
    <div class="row">
      <span class="muted">Geladen</span>
      <strong>{{ target.deliveredKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">Verbleibend</span>
      <strong>{{ target.remainingKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">Bisher aus Solarstrom</span>
      <strong>{{ target.solarKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">Bisher aus dem Netz</span>
      <strong>{{ target.gridKwh.toFixed(1) }} kWh</strong>
    </div>
    <p class="muted" style="margin: 0.25rem 0 0">
      Das Gebäude hat nur einen einzigen Zähler. Die Aufteilung folgt deshalb dem, wofür sich die
      Optimierung zum jeweiligen Zeitpunkt entschieden hat, und ist keine Messung der tatsächlichen
      Herkunft des Stroms.
    </p>

    <p
      v-if="target.reachability.state === 'unreachable'"
      class="warning"
      style="margin-top: 0.75rem"
    >
      Dieses Ladeziel lässt sich unter der Preisregel bis zum Termin nicht erreichen – es werden
      voraussichtlich rund {{ target.reachability.expectedShortfallKwh.toFixed(1) }} kWh fehlen.
      Wählen Sie einen späteren Termin oder eine kleinere Menge.
    </p>
    <p
      v-else-if="target.reachability.state === 'at_risk'"
      class="muted"
      style="margin-top: 0.75rem"
    >
      Auf Kurs, aber ohne viel Reserve. Sobald Ihr Termin es verlangt, wird aus dem Netz geladen.
    </p>

    <button
      class="secondary"
      style="margin-top: 1rem"
      @click="chargers.cancelTarget(props.lotNumber)"
    >
      Ladeziel löschen
    </button>
  </div>

  <div v-else-if="charger" class="card">
    <h2>Kein Ladeziel gesetzt</h2>
    <p class="muted">Sagen Sie dem System, wie viel Energie Sie bis wann brauchen.</p>
    <router-link :to="`/chargers/${props.lotNumber}/target`">
      <button>Ladeziel setzen</button>
    </router-link>
  </div>

  <router-link v-if="charger && target" :to="`/chargers/${props.lotNumber}/target`">
    <button class="secondary">Ladeziel ändern</button>
  </router-link>

  <button
    v-if="charger && !charger.override.active"
    class="secondary"
    style="margin-top: 0.5rem"
    @click="chargers.setOverride(props.lotNumber, true)"
  >
    Jetzt laden (Optimierung übergehen)
  </button>

  <p v-if="!charger && !chargers.loading" class="muted">
    Für diesen Parkplatz wurde keine Ladestation gefunden.
  </p>
</template>
