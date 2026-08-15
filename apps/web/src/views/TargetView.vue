<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
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
const deadlineLabel = computed(() =>
  deadline.value.toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }),
)

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
        `Saved — but this target cannot be met under the price policy. ` +
        `Expect about ${result.reachability.expectedShortfallKwh.toFixed(1)} kWh short. ` +
        `A later deadline or less energy would fix it.`
      return
    }
    await router.push(`/chargers/${props.lotNumber}`)
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === 'deadline_too_soon') {
      const earliest = cause.earliestFeasibleDeadline
        ? new Date(cause.earliestFeasibleDeadline).toLocaleString(undefined, {
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })
        : 'later'
      problem.value = `That deadline is too soon. The earliest that works is ${earliest}.`
    } else {
      problem.value = 'Could not save the target. Try again.'
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <h1>Charge {{ props.lotNumber }}</h1>

  <div class="card">
    <label for="energy">How much energy?</label>
    <div class="value">{{ energyKwh }} kWh</div>
    <input id="energy" v-model.number="energyKwh" type="range" min="1" max="100" step="1" />

    <label for="deadline" style="margin-top: 1rem">Ready by</label>
    <div class="value">{{ deadlineLabel }}</div>
    <p class="muted">in {{ hoursAhead }} hour{{ hoursAhead === 1 ? '' : 's' }}</p>
    <input id="deadline" v-model.number="hoursAhead" type="range" min="1" max="48" step="1" />
  </div>

  <p v-if="problem" class="card warning">{{ problem }}</p>

  <button :disabled="submitting" @click="confirm">
    {{ submitting ? 'Saving…' : 'Confirm' }}
  </button>
  <button class="secondary" style="margin-top: 0.5rem" @click="router.back()">Cancel</button>

  <p class="muted" style="margin-top: 1rem">
    Charging starts at the next optimization cycle, within five minutes. Your car is charged from
    the building's solar surplus where possible, and never from the grid during the 11:00–13:00 and
    18:00–20:00 high-price windows.
  </p>
</template>
