<script setup lang="ts">
import { nextTick, ref, useId } from 'vue'
import type { ColumnHelp } from '../columns'

/**
 * A table header that explains itself.
 *
 * The tooltip is teleported to the body and placed in viewport coordinates rather than laid out
 * inside the cell: header cells are `position: sticky` inside a dense table, so an absolutely
 * positioned panel would either be clipped or would drag a horizontal scrollbar into existence on
 * the last column. Clamping to the viewport here is what lets the rightmost columns carry the same
 * amount of explanation as the leftmost.
 */
const props = defineProps<ColumnHelp>()

const tipId = useId()
const trigger = ref<HTMLElement | null>(null)
const tip = ref<HTMLElement | null>(null)
const open = ref(false)
const left = ref(0)
const top = ref(0)

/** Viewport breathing room, and the gap between the header and its tooltip. */
const MARGIN = 8
const GAP = 6

async function show(): Promise<void> {
  open.value = true
  await nextTick()
  const anchor = trigger.value?.getBoundingClientRect()
  const panel = tip.value?.getBoundingClientRect()
  if (!anchor || !panel) return
  left.value = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - panel.width - MARGIN))
  // Below the header unless that would run off the bottom — long value lists often would.
  top.value =
    anchor.bottom + GAP + panel.height > window.innerHeight - MARGIN
      ? Math.max(MARGIN, anchor.top - panel.height - GAP)
      : anchor.bottom + GAP
}

function hide(): void {
  open.value = false
}
</script>

<template>
  <th>
    <span
      ref="trigger"
      class="col-help"
      tabindex="0"
      :aria-describedby="open ? tipId : undefined"
      @mouseenter="show"
      @mouseleave="hide"
      @focus="show"
      @blur="hide"
      @keydown.esc="hide"
    >
      {{ props.label }}<span class="col-mark" aria-hidden="true">?</span>
    </span>

    <Teleport to="body">
      <div
        v-if="open"
        :id="tipId"
        ref="tip"
        class="col-tip"
        role="tooltip"
        :style="{ left: `${left}px`, top: `${top}px` }"
      >
        <p>{{ props.description }}</p>
        <dl v-if="props.values">
          <template v-for="[value, meaning] in props.values" :key="value">
            <dt>{{ value }}</dt>
            <dd>{{ meaning }}</dd>
          </template>
        </dl>
      </div>
    </Teleport>
  </th>
</template>
