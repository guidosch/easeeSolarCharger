<script setup lang="ts">
import { computed, onMounted } from 'vue'
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

const deadlineLabel = computed(() =>
  target.value
    ? new Date(target.value.deadline).toLocaleString(undefined, {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '',
)

onMounted(() => {
  void chargers.load()
})
</script>

<template>
  <h1>Parking lot {{ props.lotNumber }}</h1>

  <p v-if="chargers.error" class="card warning">{{ chargers.error }}</p>

  <!-- FR-034: an active override, and the fact that optimization is suspended, must both be visible. -->
  <div v-if="charger?.override.active" class="card warning">
    <h2 style="margin-top: 0">Charging now, optimization suspended</h2>
    <p style="margin: 0 0 0.75rem">
      This charger is running at full power regardless of solar surplus, the high-price windows and
      your deadline. It switches itself off when the session ends.
    </p>
    <button class="secondary" @click="chargers.setOverride(props.lotNumber, false)">
      Resume optimized charging
    </button>
  </div>

  <div v-if="charger" class="card">
    <span :class="stateClass(charger.state)">{{ STATE_LABELS[charger.state] }}</span>

    <div class="row" style="margin-top: 0.75rem">
      <span class="muted">Current being delivered</span>
      <strong>{{ charger.deliveredCurrentA.toFixed(1) }} A</strong>
    </div>
    <p class="muted" style="margin: 0">
      Read back from the charger, so it reflects what the building's load management is actually
      allowing.
    </p>

    <p v-if="charger.state === 'waiting_for_surplus'" class="muted" style="margin: 0.75rem 0 0">
      Your car is plugged in and ready. The system is waiting for enough solar surplus to charge
      without drawing from the grid — it will charge from the grid later if your deadline needs it.
    </p>
  </div>

  <div v-if="charger && target" class="card">
    <h2>{{ target.energyKwh }} kWh by {{ deadlineLabel }}</h2>

    <div class="bar"><span :style="{ width: `${progressPercent}%` }" /></div>
    <div class="row">
      <span class="muted">Delivered</span>
      <strong>{{ target.deliveredKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">Remaining</span>
      <strong>{{ target.remainingKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">From solar so far</span>
      <strong>{{ target.solarKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">From the grid so far</span>
      <strong>{{ target.gridKwh.toFixed(1) }} kWh</strong>
    </div>
    <p class="muted" style="margin: 0.25rem 0 0">
      The building has a single meter, so the split follows what the optimizer chose to charge from
      at each moment rather than a measurement of where the electrons came from.
    </p>

    <p
      v-if="target.reachability.state === 'unreachable'"
      class="warning"
      style="margin-top: 0.75rem"
    >
      This target cannot be met before the deadline under the price policy — expect about
      {{ target.reachability.expectedShortfallKwh.toFixed(1) }} kWh short. Set a later deadline or a
      smaller amount.
    </p>
    <p
      v-else-if="target.reachability.state === 'at_risk'"
      class="muted"
      style="margin-top: 0.75rem"
    >
      On track, but with little room to spare. Charging from the grid will start as soon as the
      deadline needs it.
    </p>

    <button
      class="secondary"
      style="margin-top: 1rem"
      @click="chargers.cancelTarget(props.lotNumber)"
    >
      Cancel target
    </button>
  </div>

  <div v-else-if="charger" class="card">
    <h2>No target set</h2>
    <p class="muted">Tell the system how much energy you need and by when.</p>
    <router-link :to="`/chargers/${props.lotNumber}/target`">
      <button>Set a target</button>
    </router-link>
  </div>

  <router-link v-if="charger && target" :to="`/chargers/${props.lotNumber}/target`">
    <button class="secondary">Change target</button>
  </router-link>

  <button
    v-if="charger && !charger.override.active"
    class="secondary"
    style="margin-top: 0.5rem"
    @click="chargers.setOverride(props.lotNumber, true)"
  >
    Charge now (ignore the optimization)
  </button>

  <p v-if="!charger && !chargers.loading" class="muted">No charger found for this parking lot.</p>
</template>
