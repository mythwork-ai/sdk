import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  // Pre-bundle the deep yjs deps the React tests reach so Vite doesn't discover
  // one mid-run on a cold cache and reload ("Vite unexpectedly reloaded a
  // test"). Same fix orbit-collab/orbit-kernel use.
  optimizeDeps: {
    include: ['yjs', 'y-protocols/awareness', 'y-websocket', 'lib0/observable'],
  },
  test: {
    // Default to node: the transport/handshake/client/dev tests rely on Node's
    // native MessageChannel timing (happy-dom's MessagePort delivers on a looser
    // schedule and flakes their single-flush assertions). The React .tsx tests
    // opt into happy-dom per-file via `// @vitest-environment happy-dom`.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
