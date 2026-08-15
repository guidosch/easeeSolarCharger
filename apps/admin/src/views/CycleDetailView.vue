<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { adminFetch } from '../api'

/**
 * One complete cycle record (T111 companion view).
 *
 * Shown as raw JSON on purpose: this is the payload `decide()` must reproduce exactly (SC-010), and
 * the operator's next step after reading it is usually to paste it into a regression fixture.
 */
const props = defineProps<{ cycleId: string }>()

const record = ref<unknown>(null)
const error = ref<string | null>(null)

onMounted(async () => {
  try {
    record.value = await adminFetch(`/cycles/${encodeURIComponent(props.cycleId)}`)
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'failed to load'
  }
})
</script>

<template>
  <h2>Cycle {{ props.cycleId }}</h2>
  <p v-if="error" class="error">{{ error }}</p>
  <p class="hint">
    This is the exact input set <code>decide()</code> must reproduce. Copy it into
    <code>fixtures/</code> to turn this cycle into a regression test.
  </p>
  <pre v-if="record">{{ JSON.stringify(record, null, 2) }}</pre>
</template>
