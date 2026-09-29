<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { formatDeadline } from '../format'
import { ApiError } from '../stores/session'
import { useChargersStore } from '../stores/chargers'

/**
 * Two sliders and one confirmation (T067, FR-006, SC-001).
 *
 * The deadline slider is expressed in *hours from now* rather than as a date-time picker: it is one
 * gesture instead of five, which is what keeps the whole flow under sixty seconds.
 */
const props = defineProps<{ lotNumber: string }>()

const chargers = useChargersStore()
const router = useRouter()

const energyKwh = ref(20)
const hoursAhead = ref(9)
const submitting = ref(false)
const problem = ref<string | null>(null)

const deadline = computed(() => new Date(Date.now() + hoursAhead.value * 3_600_000))
const deadlineLabel = computed(() => formatDeadline(deadline.value))

async function confirm(): Promise<void> {
  submitting.value = true
  problem.value = null
  try {
    const result = await chargers.setTarget(
      props.lotNumber,
      energyKwh.value,
      deadline.value.toISOString(),
    )
    if (result.reachability.state === 'unreachable') {
      // Accepted, but the shortfall is stated now rather than discovered at the deadline (FR-036).
      problem.value =
        `Gespeichert – dieses Ladeziel lässt sich unter der Preisregel aber nicht erreichen. ` +
        `Es werden voraussichtlich rund ${result.reachability.expectedShortfallKwh.toFixed(1)} kWh fehlen. ` +
        `Ein späterer Termin oder weniger Energie würde das beheben.`
      return
    }
    await router.push(`/chargers/${props.lotNumber}`)
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'deadline_too_soon') {
      const earliest = cause.earliestFeasibleDeadline
        ? formatDeadline(cause.earliestFeasibleDeadline)
        : 'später'
      problem.value = `Dieser Termin ist zu früh. Frühestens möglich ist ${earliest}.`
    } else {
      problem.value = 'Das Ladeziel konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.'
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <h1>Parkplatz {{ props.lotNumber }} laden</h1>

  <div class="card">
    <label for="energy">Wie viel Energie?</label>
    <div class="value">{{ energyKwh }} kWh</div>
    <input id="energy" v-model.number="energyKwh" type="range" min="1" max="100" step="1" />

    <label for="deadline" style="margin-top: 1rem">Bereit bis</label>
    <div class="value">{{ deadlineLabel }}</div>
    <p class="muted">in {{ hoursAhead }} Stunde{{ hoursAhead === 1 ? '' : 'n' }}</p>
    <input id="deadline" v-model.number="hoursAhead" type="range" min="1" max="72" step="1" />
  </div>

  <p v-if="problem" class="card warning">{{ problem }}</p>

  <button :disabled="submitting" @click="confirm">
    {{ submitting ? 'Wird gespeichert…' : 'Bestätigen' }}
  </button>
  <button class="secondary" style="margin-top: 0.5rem" @click="router.back()">Abbrechen</button>

  <p class="muted" style="margin-top: 1rem">
    Das Laden beginnt mit dem nächsten Optimierungszyklus, also innerhalb von fünf Minuten. Ihr Auto
    wird wenn möglich aus dem Solarüberschuss des Gebäudes geladen und während der Hochpreisfenster
    von 11:00–13:00 und 18:00–20:00 Uhr nie aus dem Netz.
  </p>
  <p>
    Warum muss ich die Energie und den Termin angeben? Das System kann nur dann optimieren, wenn es
    weiß, wie viel Energie Sie benötigen und wann Ihr Auto wieder verfügbar sein muss. So kann es
    die Ladeleistung optimal verteilen und den Solarüberschuss effizient nutzen.
  </p>
</template>
