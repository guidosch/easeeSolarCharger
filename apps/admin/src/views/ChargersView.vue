<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { AdminChargerView } from '@app/shared'
import { adminFetch } from '../api'
import { CHARGER_COLUMNS as COL } from '../columns'
import ColumnHeader from '../components/ColumnHeader.vue'

/**
 * Every charger, with commanded versus delivered current (T117, FR-040).
 *
 * The `discrepancy` column is the Principle I read-back reconciliation made visible rather than
 * hidden: `capped` means the external load manager overruled this system, `lost` means the setpoint
 * did not stick — most often because a plug-in reset it (research R5).
 */
const chargers = ref<AdminChargerView[]>([])
const error = ref<string | null>(null)
// Orphaned mappings are an operator data problem, not live charging — hidden unless asked for, so
// they don't crowd the chargers that actually drive.
const showOrphaned = ref(false)
const orphanedCount = computed(() => chargers.value.filter((c) => c.orphaned).length)
const visibleChargers = computed(() =>
  showOrphaned.value ? chargers.value : chargers.value.filter((c) => !c.orphaned),
)

async function load(): Promise<void> {
  try {
    chargers.value = await adminFetch<AdminChargerView[]>('/chargers')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'failed to load'
  }
}

onMounted(load)
</script>

<template>
  <p v-if="error" class="error">{{ error }}</p>

  <div class="range">
    <label>
      <input v-model="showOrphaned" type="checkbox" />
      Show orphaned mappings ({{ orphanedCount }})
    </label>
  </div>

  <table>
    <thead>
      <tr>
        <ColumnHeader v-bind="COL.lot" />
        <ColumnHeader v-bind="COL.line" />
        <ColumnHeader v-bind="COL.state" />
        <ColumnHeader v-bind="COL.opMode" />
        <ColumnHeader v-bind="COL.commanded" />
        <ColumnHeader v-bind="COL.delivered" />
        <ColumnHeader v-bind="COL.believes" />
        <ColumnHeader v-bind="COL.discrepancy" />
        <ColumnHeader v-bind="COL.target" />
        <ColumnHeader v-bind="COL.reachability" />
        <ColumnHeader v-bind="COL.user" />
        <ColumnHeader v-bind="COL.trace" />
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="charger in visibleChargers"
        :key="charger.lotNumber"
        :class="charger.orphaned ? 'warn-row' : ''"
      >
        <td>{{ charger.lotNumber }}</td>
        <td>{{ charger.line }}</td>
        <td>{{ charger.state }}</td>
        <td>{{ charger.opMode }}</td>
        <td>{{ charger.commandedCurrentA }} A</td>
        <td>{{ charger.deliveredCurrentA }} A</td>
        <td>{{ charger.dynamicChargerCurrentA }} A</td>
        <td :class="charger.discrepancy === 'none' ? 'ok' : 'warn'">{{ charger.discrepancy }}</td>
        <td>
          <template v-if="charger.target">
            {{ charger.target.deliveredKwh.toFixed(1) }} / {{ charger.target.energyKwh }} kWh
          </template>
          <template v-else>—</template>
        </td>
        <td :class="charger.target?.reachability.state === 'unreachable' ? 'warn' : ''">
          <template v-if="charger.target">
            {{ charger.target.reachability.state }}
            <template v-if="charger.target.reachability.expectedShortfallKwh > 0">
              (−{{ charger.target.reachability.expectedShortfallKwh.toFixed(1) }} kWh)
            </template>
          </template>
          <template v-else>—</template>
        </td>
        <td>
          <template v-if="charger.user">{{ charger.user.email ?? charger.user.userId }}</template>
          <template v-else><em>orphaned mapping</em></template>
        </td>
        <td><router-link :to="`/chargers/${charger.lotNumber}/trace`">trace</router-link></td>
      </tr>
    </tbody>
  </table>
</template>
