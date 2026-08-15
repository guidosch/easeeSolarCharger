<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { TraceEntry } from '@app/shared'
import { adminFetch } from '../api'

/**
 * The per-charger decision trail (T118, FR-042, SC-009).
 *
 * This view exists to answer one question — "why did charger 12 not charge between 14:00 and
 * 15:00?" — in under five minutes, using only what is recorded. `ladderRule` is the column that
 * makes it a one-glance answer: it names which rule of the Principle I ladder decided each cycle.
 */
const props = defineProps<{ lotNumber: string }>()

const entries = ref<TraceEntry[]>([])
const error = ref<string | null>(null)
const from = ref(new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 16))
const to = ref(new Date().toISOString().slice(0, 16))

const RULES: Record<string, string> = {
  '1': 'line headroom',
  '2': 'override',
  '3': 'high price',
  '4': 'deadline',
  '5': 'solar',
  '6': 'fairness',
}

function local(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/Zurich' })
}

async function load(): Promise<void> {
  error.value = null
  try {
    const query = `?from=${new Date(from.value).toISOString()}&to=${new Date(to.value).toISOString()}`
    entries.value = await adminFetch<TraceEntry[]>(
      `/chargers/${encodeURIComponent(props.lotNumber)}/trace${query}`,
    )
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'failed to load'
  }
}

onMounted(load)
</script>

<template>
  <h2>Parking lot {{ props.lotNumber }}</h2>

  <form class="range" @submit.prevent="load">
    <label>From <input v-model="from" type="datetime-local" /></label>
    <label>To <input v-model="to" type="datetime-local" /></label>
    <button type="submit">Show</button>
  </form>

  <p v-if="error" class="error">{{ error }}</p>

  <table>
    <thead>
      <tr>
        <th>Cycle</th>
        <th>Commanded</th>
        <th>Delivered</th>
        <th>Reason</th>
        <th>Decided by</th>
        <th>Discrepancy</th>
        <th>Events</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="entry in entries" :key="entry.cycleId">
        <td>{{ local(entry.startedAt) }}</td>
        <td>{{ entry.targetCurrentA }} A</td>
        <td>{{ entry.deliveredCurrentA }} A</td>
        <td>{{ entry.reason }}</td>
        <td>
          <template v-if="entry.ladderRule">
            rule {{ entry.ladderRule }} — {{ RULES[String(entry.ladderRule)] }}
          </template>
          <template v-else>—</template>
        </td>
        <td :class="entry.discrepancy && entry.discrepancy !== 'none' ? 'warn' : ''">
          {{ entry.discrepancy ?? '—' }}
        </td>
        <td>{{ entry.events.map((e) => e.type).join(', ') || '—' }}</td>
      </tr>
    </tbody>
  </table>

  <p v-if="entries.length === 0 && !error">No cycles recorded in that window.</p>
</template>
