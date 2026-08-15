<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { AdminChargerView } from '@app/shared'
import { adminFetch } from '../api'

/**
 * Every charger, with commanded versus delivered current (T117, FR-040).
 *
 * The `discrepancy` column is the Principle I read-back reconciliation made visible rather than
 * hidden: `capped` means the external load manager overruled this system, `lost` means the setpoint
 * did not stick — most often because a plug-in reset it (research R5).
 */
const chargers = ref<AdminChargerView[]>([])
const error = ref<string | null>(null)

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

  <table>
    <thead>
      <tr>
        <th>Lot</th>
        <th>Line</th>
        <th>State</th>
        <th>opMode</th>
        <th>Commanded</th>
        <th>Delivered</th>
        <th>Charger believes</th>
        <th>Discrepancy</th>
        <th>Target</th>
        <th>Reachability</th>
        <th>User</th>
        <th>Trace</th>
      </tr>
    </thead>
    <tbody>
      <tr
        v-for="charger in chargers"
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
