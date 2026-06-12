// @mythwork/sdk — the inner-app client over the Mythwork postMessage protocol.
//
// Usage:
//
//   import { connect } from '@mythwork/sdk'
//   const sdk = await connect()
//   const { pid } = await sdk.project.create({ projectName: 'demo' })
//   await sdk.fs.write({ pid, path: 'index.html', bytes })
//   const off = sdk.fs.onChanged(({ path }) => console.log('changed', path))
//
// `connect()` performs the host handshake (acquiring the MessagePort) and hands
// back a {@link MythworkClient}: a typed `request()`/`subscribe()` plus thin
// namespaced helpers that map clean names to the deployed wire method strings.
// It is dependency-free except for `@mythwork/protocol` (the wire spec).

import { acquirePort, browserEnv, type HandshakeEnv } from './handshake'
import { MythworkClient } from './client'

// Re-export the protocol so consumers get the wire spec (types, constants)
// without a second dependency.
export * from '@mythwork/protocol'

export { MythworkClient } from './client'
export type { EventHandler, EventPrefix } from './client'
export { requestOverPort, PushRouter } from './transport'
export type { RequestOptions, PushHandler } from './transport'
export { acquirePort, browserEnv, NO_PORT_ERROR } from './handshake'
export type { HandshakeEnv, HandshakeOptions } from './handshake'

/** Options for {@link connect}. */
export interface ConnectOptions {
  /**
   * Total budget, in milliseconds, to spend acquiring the host port before
   * rejecting. Defaults to the protocol's `PING_BUDGET_MS` (5000).
   */
  timeoutMs?: number
  /**
   * Override the DOM environment the handshake runs against. Defaults to the
   * real browser `window` ({@link browserEnv}). Primarily a testing seam.
   */
  env?: HandshakeEnv
}

/**
 * Connect to the Mythwork host frame and resolve a ready {@link MythworkClient}.
 *
 * Performs the port handshake along whichever path applies:
 *
 * - (a) A platform bootstrap (the serve-worker-injected shim or an SPA
 *   entrypoint) already installed `window.__oc.port` — the client discovers it
 *   via the `'ocready'` event / poll, exactly like the internal shim-transport.
 * - (b) No port has appeared — the client runs the `oc-ping` loop itself
 *   (posting `{ type: 'oc-ping' }` to `window.parent` every `PING_INTERVAL_MS`
 *   within the budget), receives the host's `oc-init` reply carrying the
 *   transferred port, installs it at `window.__oc.port`, and dispatches the same
 *   `'ocready'` event the platform fires so any co-resident transport converges.
 *
 * Rejects with a clear error if no host port appears within `timeoutMs`.
 */
export async function connect(opts?: ConnectOptions): Promise<MythworkClient> {
  const env = opts?.env ?? browserEnv()
  const port = await acquirePort(env, { timeoutMs: opts?.timeoutMs })
  return new MythworkClient(port)
}
