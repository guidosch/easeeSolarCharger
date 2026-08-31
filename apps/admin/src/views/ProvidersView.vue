<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AdminProviderHealth } from '@app/shared'
import { adminFetch } from '../api'
import { PROVIDER_COLUMNS as COL } from '../columns'
import ColumnHeader from '../components/ColumnHeader.vue'

/**
 * Per-provider budget, errors and rate limits over 24 hours (T119, FR-041).
 *
 * Call volume is a correctness constraint here, not a cost line: SolarEdge's 300/day is tight
 * enough that a careless retry loop blinds the optimizer for the rest of the day, so the remaining
 * budget is shown next to the error count rather than buried.
 */
const providers = ref<AdminProviderHealth[]>([])
const error = ref<string | null>(null)

async function load(): Promise<void> {
  try {
    providers.value = await adminFetch<AdminProviderHealth[]>('/providers')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'failed to load'
  }
}

onMounted(load)
</script>

<template>
  <p v-if="error" class="error">{{ error }}</p>

  <table>
    <thead>
      <tr>
        <ColumnHeader v-bind="COL.provider" />
        <ColumnHeader v-bind="COL.calls" />
        <ColumnHeader v-bind="COL.budget" />
        <ColumnHeader v-bind="COL.errors" />
        <ColumnHeader v-bind="COL.rateLimited" />
        <ColumnHeader v-bind="COL.daylightGate" />
        <ColumnHeader v-bind="COL.lastError" />
      </tr>
    </thead>
    <tbody>
      <tr v-for="provider in providers" :key="provider.provider">
        <td>{{ provider.provider }}</td>
        <td :class="provider.callsLast24h > provider.budget * 0.8 ? 'warn' : ''">
          {{ provider.callsLast24h }}
        </td>
        <td>{{ provider.budget }}</td>
        <td :class="provider.errors > 0 ? 'warn' : 'ok'">{{ provider.errors }}</td>
        <td :class="provider.rateLimited > 0 ? 'warn' : 'ok'">{{ provider.rateLimited }}</td>
        <td>
          <template v-if="provider.daylightGateOpen === null">n/a</template>
          <template v-else>{{ provider.daylightGateOpen ? 'open' : 'closed' }}</template>
        </td>
        <td>
          <template v-if="provider.lastError">
            {{
              new Date(provider.lastError.at).toLocaleString('en-GB', { timeZone: 'Europe/Zurich' })
            }}
            — {{ provider.lastError.message }}
            <code>{{ provider.lastError.correlationId }}</code>
          </template>
          <template v-else>—</template>
        </td>
      </tr>
    </tbody>
  </table>
</template>
