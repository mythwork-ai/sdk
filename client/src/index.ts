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
export { requestOverPort, streamOverPort, PushRouter } from './transport'
export type { RequestOptions, StreamOptions, PushHandler } from './transport'
export { acquirePort, browserEnv, getInitialPath, NO_PORT_ERROR } from './handshake'
export type { HandshakeEnv, HandshakeOptions } from './handshake'

// Top-level auth-consume: obtain + use the platform session from a page with NO
// host frame (the landing site, a served app's own chrome) via the auth-iframe
// postMessage bridge + the `/signin` redirect entry.
export { connectAuth, browserAuthEnv } from './auth'
export { zoneHost } from './zone'
export type {
  AuthConsumer,
  AuthUser,
  AuthChangeCallback,
  ConnectAuthOptions,
  AuthEnv,
  AuthFrame,
} from './auth'

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
  /**
   * When truthy, skip the host handshake and instead connect to the built-in
   * dev host backed by generic seed fixtures. No app-side mock server required.
   *
   * Pass `true` for the default (signed-in user adopts the first seed maker), or
   * an options object to tune the dev host:
   * - `{ noProfile: true }` starts in onboarding mode (signed-in user with no
   *   claimed handle, so `profile.me` reports `no_profile` until
   *   `profile.claimHandle` records one).
   * - `{ firstParty: true }` simulates a first-party/allowlisted app so anonymous
   *   `ai.*` works in dev — mirroring production, where the serve worker mints a
   *   first-party token (e.g. myth-landing's signed-out hero planner). Without it
   *   the dev host throws `'sign in required'` for anonymous `ai.chat`/`ai.complete`,
   *   imitating a non-allowlisted app.
   *
   * The dev host module is **dynamically imported** so it is excluded from
   * production bundles when this option is not used.
   *
   * @example
   * ```ts
   * // vite.config.ts / any bundler entry
   * import { connect } from '@mythwork/sdk'
   * const sdk = await connect({ dev: import.meta.env.DEV })
   * // Exercise the onboarding flow:
   * const sdk = await connect({ dev: { noProfile: true } })
   * // Allowlisted app: anonymous ai.* works in dev:
   * const sdk = await connect({ dev: { firstParty: true } })
   * ```
   */
  dev?: boolean | { noProfile?: boolean; firstParty?: boolean }
}

/**
 * Connect to the Mythwork host frame and resolve a ready {@link MythworkClient}.
 *
 * Performs the port handshake along whichever path applies:
 *
 * - (a) `opts.dev === true` — connects to the built-in dev host (generic seed
 *   fixtures, no real host required). The dev host module is dynamically
 *   imported so it is excluded from production bundles.
 * - (b) A platform bootstrap (the serve-worker-injected shim or an SPA
 *   entrypoint) already installed `window.__oc.port` — the client discovers it
 *   via the `'ocready'` event / poll, exactly like the internal shim-transport.
 * - (c) No port has appeared — the client runs the `oc-ping` loop itself
 *   (posting `{ type: 'oc-ping' }` to `window.parent` every `PING_INTERVAL_MS`
 *   within the budget), receives the host's `oc-init` reply carrying the
 *   transferred port, installs it at `window.__oc.port`, and dispatches the same
 *   `'ocready'` event the platform fires so any co-resident transport converges.
 *
 * Rejects with a clear error if no host port appears within `timeoutMs`.
 */
export async function connect(opts?: ConnectOptions): Promise<MythworkClient> {
  if (opts?.dev) {
    // Dynamic import keeps the dev host + seed out of production bundles.
    const { createDevHost } = await import('./dev/host')
    const devOpts = typeof opts.dev === 'object' ? opts.dev : undefined
    return new MythworkClient(createDevHost(devOpts))
  }
  const env = opts?.env ?? browserEnv()
  const port = await acquirePort(env, { timeoutMs: opts?.timeoutMs })
  return new MythworkClient(port)
}
