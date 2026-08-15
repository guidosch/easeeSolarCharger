<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { SessionSummary } from '@app/shared'
import { useSessionStore } from '../stores/session'

/**
 * The last five sessions (T094, FR-037, FR-038).
 *
 * The solar/grid split is stated as an attribution, not a measurement — the building has only
 * site-level metering, so claiming to know which electrons went where would be a fiction. The
 * wording says so, because the spec requires the UI to.
 */
const session = useSessionStore()
const sessions = ref<SessionSummary[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

function when(value: string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—'
}

const END_REASONS: Record<string, string> = {
  target_reached: 'Target reached',
  unplugged: 'Unplugged early',
  cancelled: 'Cancelled',
  deadline_passed: 'Deadline passed',
}

onMounted(async () => {
  try {
    sessions.value = await session.request<SessionSummary[]>('/api/sessions')
  } catch {
    error.value = 'Could not load your history.'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <h1>History</h1>

  <p v-if="loading" class="muted">Loading…</p>
  <p v-else-if="error" class="card warning">{{ error }}</p>
  <p v-else-if="sessions.length === 0" class="muted">No charging sessions yet.</p>

  <div v-for="entry in sessions" :key="entry.sessionId" class="card">
    <div class="row">
      <h2 style="margin: 0">Lot {{ entry.lotNumber }}</h2>
      <span :class="entry.targetMet ? 'state' : 'state idle'">
        {{ entry.targetMet ? 'Target met' : (END_REASONS[entry.endReason ?? ''] ?? 'Ended') }}
      </span>
    </div>
    <p class="muted" style="margin: 0.25rem 0 0.75rem">
      {{ when(entry.startedAt) }} → {{ when(entry.endedAt) }}
    </p>

    <div class="row">
      <span class="muted">Delivered</span><strong>{{ entry.energyKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">From solar</span><strong>{{ entry.solarKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">From the grid</span><strong>{{ entry.gridKwh.toFixed(1) }} kWh</strong>
    </div>
    <p v-if="entry.overrideUsed" class="muted" style="margin: 0.5rem 0 0">
      "Charge now" was used during this session, so optimization was suspended.
    </p>
  </div>

  <p v-if="sessions.length > 0" class="muted">
    The solar and grid split reflects what the optimizer decided to charge from at each moment. The
    building has one meter for everything, so this is an attribution rather than a measurement, and
    only the five most recent sessions are kept.
  </p>
</template>
