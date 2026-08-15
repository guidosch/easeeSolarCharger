/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  /* eslint-disable @typescript-eslint/no-explicit-any -- standard Vue ambient declaration. */
  const component: DefineComponent<Record<string, any>, Record<string, any>, any>
  /* eslint-enable @typescript-eslint/no-explicit-any */
  export default component
}
