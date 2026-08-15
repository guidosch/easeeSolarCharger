import { fileURLToPath } from 'node:url'
import { defineWorkspace } from 'vitest/config'

const pkg = (p: string) => fileURLToPath(new URL(p, import.meta.url))

/**
 * Workspace packages are resolved to their TypeScript sources so tests always exercise the code
 * that is reviewed, never a stale build output.
 */
const alias = {
  '@app/shared': pkg('./packages/shared/src/index.ts'),
  '@app/core': pkg('./packages/core/src/index.ts'),
  '@app/adapters': pkg('./packages/adapters/src/index.ts'),
}

export default defineWorkspace([
  {
    resolve: { alias },
    test: {
      name: 'unit',
      root: './packages/core',
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'contract',
      root: './packages/adapters',
      environment: 'node',
      include: ['tests/contract/**/*.test.ts'],
    },
  },
  {
    resolve: { alias },
    test: {
      name: 'integration',
      root: '.',
      environment: 'node',
      include: ['services/*/tests/**/*.test.ts'],
      testTimeout: 20_000,
    },
  },
])
