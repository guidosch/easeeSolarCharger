<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { TraceEntry } from '@app/shared'
import { adminFetch } from '../api'
import { LADDER_RULES, TRACE_COLUMNS as COL } from '../columns'
import ColumnHeader from '../components/ColumnHeader.vue'
import { SITE_TIMEZONE, formatTimeOfDay, fromDateTimeLocal, toDateTimeLocal } from '../time'

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
// Both ends of the range are site-local wall-clock times, like every other time on this page — the
// `datetime-local` control carries no zone of its own, so it is filled and read back through the
// site's zone rather than through UTC or the operator's browser.
const from = ref(toDateTimeLocal(Date.now() - 3 * 3_600_000))
const to = ref(toDateTimeLocal(Date.now()))

async function load(): Promise<void> {
  error.value = null
  try {
    const query = `?from=${fromDateTimeLocal(from.value)}&to=${fromDateTimeLocal(to.value)}`
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
    <!-- The control shows no zone of its own, and which zone it means is the whole question when
         an operator is matching a user's "it was about half past two". -->
    <span class="hint">{{ SITE_TIMEZONE }} local time</span>
  </form>

  <p v-if="error" class="error">{{ error }}</p>

  <table>
    <thead>
      <tr>
        <ColumnHeader v-bind="COL.cycle" />
        <ColumnHeader v-bind="COL.commanded" />
        <ColumnHeader v-bind="COL.delivered" />
        <ColumnHeader v-bind="COL.reason" />
        <ColumnHeader v-bind="COL.ladderRule" />
        <ColumnHeader v-bind="COL.discrepancy" />
        <ColumnHeader v-bind="COL.events" />
      </tr>
    </thead>
    <tbody>
      <tr v-for="entry in entries" :key="entry.cycleId">
        <td>{{ formatTimeOfDay(entry.startedAt) }}</td>
        <td>{{ entry.targetCurrentA }} A</td>
        <td>{{ entry.deliveredCurrentA }} A</td>
        <td>{{ entry.reason }}</td>
        <td>
          <template v-if="entry.ladderRule">
            rule {{ entry.ladderRule }} — {{ LADDER_RULES[String(entry.ladderRule)] }}
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
