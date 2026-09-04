import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The package is dependency-free and its only runtime module with state
    // (collab-auth) touches nothing beyond atob/btoa + timers, both of which
    // Node provides.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
