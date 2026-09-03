import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { setupPwa } from './pwa'
import { router } from './router'
import './style.css'

setupPwa()

createApp(App).use(createPinia()).use(router).mount('#app')
