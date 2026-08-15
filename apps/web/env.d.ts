/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // The shape of an SFC's props is only known to the compiler; this is the standard Vue ambient
  // declaration, and there is no narrower type available here.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const component: DefineComponent<Record<string, any>, Record<string, any>, any>
  /* eslint-enable @typescript-eslint/no-explicit-any */
  export default component
}
