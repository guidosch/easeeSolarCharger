import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import ChargerListView from './views/ChargerListView.vue'
import ChargerView from './views/ChargerView.vue'
import HistoryView from './views/HistoryView.vue'
import LoginView from './views/LoginView.vue'
import SettingsView from './views/SettingsView.vue'
import TargetView from './views/TargetView.vue'
import { useSessionStore } from './stores/session'

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
  { path: '/', name: 'chargers', component: ChargerListView },
  { path: '/chargers/:lotNumber', name: 'charger', component: ChargerView, props: true },
  { path: '/chargers/:lotNumber/target', name: 'target', component: TargetView, props: true },
  { path: '/history', name: 'history', component: HistoryView },
  { path: '/settings', name: 'settings', component: SettingsView },
]

export const router = createRouter({ history: createWebHistory(), routes })

// FR-001: no charger data and no charging action without a signed-in user.
router.beforeEach((to) => {
  const session = useSessionStore()
  if (!to.meta['public'] && !session.session) return { name: 'login' }
  if (to.meta['public'] && session.session) return { name: 'chargers' }
  return true
})
