<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AdminCycleSummary, AdminHealth } from '@app/shared'
import { adminFetch } from '../api'

/**
 * Recent cycles and overall health (T116, FR-039).
 *
 * The surplus *age* sits next to its value on purpose: "why did nothing charge from solar this
 * afternoon" is almost always answered by a `quality` of `unusable`, and that column is where an
 * operator sees it without opening anything.
 */
const cycles = ref<AdminCycleSummary[]>([])
const health = ref<AdminHealth | null>(null)
const error = ref<string | null>(null)

function local(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/Zurich' })
}

async function load(): Promise<void> {
  try {
    ;[cycles.value, health.value] = await Promise.all([
      adminFetch<AdminCycleSummary[]>('/cycles?limit=50'),
      adminFetch<AdminHealth>('/health'),
    ])
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'failed to load'
  }
}

onMounted(load)
</script>

<template>
  <p v-if="error" class="error">{{ error }}</p>

  <section v-if="health" class="health">
    <div :class="['tile', health.consecutiveFailures > 0 ? 'bad' : '']">
      <span>Consecutive failures</span><strong>{{ health.consecutiveFailures }}</strong>
    </div>
    <div class="tile">
      <span>Last cycle</span>
      <strong>
        {{
          health.lastCycle
            ? `${health.lastCycle.outcome}, ${health.lastCycle.ageMinutes} min ago`
            : 'none'
        }}
      </strong>
    </div>
    <div class="tile">
      <span>Lease held</span><strong>{{ health.leaseHeld ? 'yes' : 'no' }}</strong>
    </div>
    <div :class="['tile', health.firestoreWritesToday > 5000 ? 'bad' : '']">
      <!-- Principle VI: the design budgets ~1,750/day against a 20,000 free allowance. -->
      <span>Firestore writes today</span><strong>{{ health.firestoreWritesToday }}</strong>
    </div>
    <div class="tile">
      <span>Open targets</span><strong>{{ health.openTargets }}</strong>
    </div>
    <div :class="['tile', health.unreachableTargets > 0 ? 'bad' : '']">
      <span>Unreachable targets</span><strong>{{ health.unreachableTargets }}</strong>
    </div>
  </section>

  <table>
    <thead>
      <tr>
        <th>Cycle</th>
        <th>Outcome</th>
        <th>Duration</th>
        <th>Surplus</th>
        <th>Age</th>
        <th>Quality</th>
        <th>Tariff</th>
        <th>Season</th>
        <th>Acted on</th>
        <th>Easee</th>
        <th>SolarEdge</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="cycle in cycles" :key="cycle.cycleId">
        <td>
          <router-link :to="`/cycles/${encodeURIComponent(cycle.cycleId)}`">
            {{ local(cycle.cycleId) }}
          </router-link>
        </td>
        <td :class="cycle.outcome === 'completed' ? 'ok' : 'warn'">{{ cycle.outcome }}</td>
        <td>{{ cycle.durationMs }} ms</td>
        <td>{{ cycle.surplus.smoothedKw ?? '—' }} kW</td>
        <td>{{ cycle.surplus.ageMinutes ?? '—' }} min</td>
        <td :class="cycle.surplus.quality === 'fresh' ? 'ok' : 'warn'">
          {{ cycle.surplus.quality }}
        </td>
        <td>{{ cycle.tariffWindow }}</td>
        <td>{{ cycle.seasonMode }}</td>
        <td>{{ cycle.chargersActedOn }}</td>
        <td>{{ cycle.providerCalls.easee.calls }} ({{ cycle.providerCalls.easee.errors }} err)</td>
        <td>
          {{ cycle.providerCalls.solaredge.calls }},
          {{ cycle.providerCalls.solaredge.budgetRemaining }} left
        </td>
      </tr>
    </tbody>
  </table>

  <p v-if="cycles.length === 0 && !error">No cycles recorded yet.</p>
</template>
