import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import ChargersView from './views/ChargersView.vue'
import CycleDetailView from './views/CycleDetailView.vue'
import CyclesView from './views/CyclesView.vue'
import DecisionTraceView from './views/DecisionTraceView.vue'
import ProvidersView from './views/ProvidersView.vue'
import SessionsView from './views/SessionsView.vue'
import SignInView from './views/SignInView.vue'
import { isSignedIn } from './api'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/cycles' },
  { path: '/signin', name: 'signin', component: SignInView, meta: { public: true } },
  { path: '/cycles', name: 'cycles', component: CyclesView },
  { path: '/cycles/:cycleId', name: 'cycle', component: CycleDetailView, props: true },
  { path: '/chargers', name: 'chargers', component: ChargersView },
  {
    path: '/chargers/:lotNumber/trace',
    name: 'trace',
    component: DecisionTraceView,
    props: true,
  },
  { path: '/sessions', name: 'sessions', component: SessionsView },
  { path: '/providers', name: 'providers', component: ProvidersView },
]

export const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach((to) => (to.meta['public'] || isSignedIn() ? true : { name: 'signin' }))
