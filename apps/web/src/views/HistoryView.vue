<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { SessionSummary } from '@app/shared'
import { formatMoment } from '../format'
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

const END_REASONS: Record<string, string> = {
  target_reached: 'Ziel erreicht',
  unplugged: 'Vorzeitig abgesteckt',
  cancelled: 'Abgebrochen',
  deadline_passed: 'Termin verstrichen',
}

onMounted(async () => {
  try {
    sessions.value = await session.request<SessionSummary[]>('/api/sessions')
  } catch {
    error.value = 'Ihr Verlauf konnte nicht geladen werden.'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <h1>Verlauf</h1>

  <p v-if="loading" class="muted">Wird geladen…</p>
  <p v-else-if="error" class="card warning">{{ error }}</p>
  <p v-else-if="sessions.length === 0" class="muted">Noch keine Ladevorgänge.</p>

  <div v-for="entry in sessions" :key="entry.sessionId" class="card">
    <div class="row">
      <h2 style="margin: 0">Parkplatz {{ entry.lotNumber }}</h2>
      <span :class="entry.targetMet ? 'state' : 'state idle'">
        {{ entry.targetMet ? 'Ziel erreicht' : (END_REASONS[entry.endReason ?? ''] ?? 'Beendet') }}
      </span>
    </div>
    <p class="muted" style="margin: 0.25rem 0 0.75rem">
      {{ formatMoment(entry.startedAt) }} → {{ formatMoment(entry.endedAt) }}
    </p>

    <div class="row">
      <span class="muted">Geladen</span><strong>{{ entry.energyKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">Aus Solarstrom</span><strong>{{ entry.solarKwh.toFixed(1) }} kWh</strong>
    </div>
    <div class="row">
      <span class="muted">Aus dem Netz</span><strong>{{ entry.gridKwh.toFixed(1) }} kWh</strong>
    </div>
    <p v-if="entry.overrideUsed" class="muted" style="margin: 0.5rem 0 0">
      Während dieses Ladevorgangs wurde «Jetzt laden» verwendet, die Optimierung war deshalb
      ausgesetzt.
    </p>
  </div>

  <p v-if="sessions.length > 0" class="muted">
    Die Aufteilung in Solar- und Netzstrom bildet ab, wofür sich die Optimierung zum jeweiligen
    Zeitpunkt entschieden hat. Das Gebäude hat nur einen einzigen Zähler für alles – es handelt sich
    also um eine Zuordnung und nicht um eine Messung. Aufbewahrt werden nur die fünf jüngsten
    Ladevorgänge.
  </p>
</template>
