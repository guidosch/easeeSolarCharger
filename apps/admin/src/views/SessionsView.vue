<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AdminSessionView } from '@app/shared'
import { adminFetch } from '../api'
import { SESSION_COLUMNS as COL } from '../columns'
import ColumnHeader from '../components/ColumnHeader.vue'
import { formatInstant } from '../time'

/**
 * The ten most recent charging sessions across all users, newest first.
 *
 * Carries the same information each user sees in their own history view, plus whose session it
 * was — so an operator answering "why did my car only get 5 kWh?" is looking at what the user saw.
 */
const sessions = ref<AdminSessionView[]>([])
const error = ref<string | null>(null)

const END_REASONS: Record<string, string> = {
  target_reached: 'target reached',
  unplugged: 'unplugged early',
  cancelled: 'cancelled',
  deadline_passed: 'deadline passed',
}

function outcome(session: AdminSessionView): string {
  if (session.targetMet) return 'target reached'
  if (session.endedAt === null) return 'open'
  return END_REASONS[session.endReason ?? ''] ?? 'ended'
}

async function load(): Promise<void> {
  try {
    sessions.value = await adminFetch<AdminSessionView[]>('/sessions')
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
        <ColumnHeader v-bind="COL.lot" />
        <ColumnHeader v-bind="COL.user" />
        <ColumnHeader v-bind="COL.started" />
        <ColumnHeader v-bind="COL.ended" />
        <ColumnHeader v-bind="COL.outcome" />
        <ColumnHeader v-bind="COL.energy" />
        <ColumnHeader v-bind="COL.solar" />
        <ColumnHeader v-bind="COL.grid" />
        <ColumnHeader v-bind="COL.override" />
      </tr>
    </thead>
    <tbody>
      <tr v-for="session in sessions" :key="`${session.user.userId}/${session.sessionId}`">
        <td>{{ session.lotNumber }}</td>
        <td>{{ session.user.email ?? session.user.userId }}</td>
        <td>{{ formatInstant(session.startedAt) }}</td>
        <td>{{ session.endedAt ? formatInstant(session.endedAt) : '—' }}</td>
        <td :class="session.targetMet ? 'ok' : ''">{{ outcome(session) }}</td>
        <td>{{ session.energyKwh.toFixed(1) }} kWh</td>
        <td>{{ session.solarKwh.toFixed(1) }} kWh</td>
        <td>{{ session.gridKwh.toFixed(1) }} kWh</td>
        <td>{{ session.overrideUsed ? 'yes' : '—' }}</td>
      </tr>
      <tr v-if="!error && sessions.length === 0">
        <td colspan="9">No sessions recorded yet.</td>
      </tr>
    </tbody>
  </table>
</template>
