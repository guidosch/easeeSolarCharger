import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ChargerView, SetTargetResponse } from '@app/shared'
import { useSessionStore } from './session.js'

/**
 * The charger store (T066).
 *
 * A charger is identified to the user by its **parking lot number** (FR-004) — the Easee charger id
 * never appears in the interface, because it is not what anyone in the building calls it.
 */
export const useChargersStore = defineStore('chargers', () => {
  const session = useSessionStore()
  const chargers = ref<ChargerView[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  const byLotNumber = computed(
    () => (lotNumber: string) => chargers.value.find((c) => c.lotNumber === lotNumber) ?? null,
  )

  async function load(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      chargers.value = await session.request<ChargerView[]>('/api/chargers')
    } catch (cause) {
      // A read failure is not a charging failure: the optimizer keeps running under the fail-safe
      // (FR-044), and saying "charging stopped" here would be a lie.
      error.value =
        'Der Status der Ladestationen konnte nicht aktualisiert werden. Das Laden läuft unverändert weiter.'
      if (cause instanceof Error && cause.message) console.warn(cause.message)
    } finally {
      loading.value = false
    }
  }

  async function setTarget(
    lotNumber: string,
    energyKwh: number,
    deadline: string,
  ): Promise<SetTargetResponse> {
    const response = await session.request<SetTargetResponse>(
      `/api/chargers/${encodeURIComponent(lotNumber)}/target`,
      { method: 'POST', body: JSON.stringify({ energyKwh, deadline }) },
    )
    await load()
    return response
  }

  /** FR-032. Clearing happens automatically at session end too, so this is not the only path. */
  async function setOverride(lotNumber: string, active: boolean): Promise<void> {
    await session.request(`/api/chargers/${encodeURIComponent(lotNumber)}/override`, {
      method: 'PUT',
      body: JSON.stringify({ active }),
    })
    await load()
  }

  async function cancelTarget(lotNumber: string): Promise<void> {
    await session.request(`/api/chargers/${encodeURIComponent(lotNumber)}/target`, {
      method: 'DELETE',
    })
    await load()
  }

  return { chargers, loading, error, byLotNumber, load, setTarget, setOverride, cancelTarget }
})

/** Wording the user sees. `waiting_for_surplus` versus `charging_grid` is the point (FR-035). */
export const STATE_LABELS: Record<ChargerView['state'], string> = {
  idle: 'Inaktiv',
  waiting_for_car: 'Wartet auf Ihr Auto',
  waiting_for_surplus: 'Wartet auf Solarüberschuss',
  charging_solar: 'Lädt mit Solarstrom',
  charging_grid: 'Lädt mit Netzstrom',
  complete: 'Abgeschlossen',
  error: 'Fehler an der Ladestation',
  offline: 'Ladestation offline',
}

export function stateClass(state: ChargerView['state']): string {
  if (state === 'charging_solar') return 'state'
  if (state === 'charging_grid') return 'state grid'
  if (state === 'error' || state === 'offline') return 'state problem'
  return 'state idle'
}
