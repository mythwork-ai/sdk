// Handshake constants + message shapes for acquiring the MessagePort.
//
// Two bootstrap paths both converge on the same port global (OC_PORT_GLOBAL):
//   a. Platform bootstrap: the host pre-installs the port before the inner
//      app loads — `window.__oc.port` is already populated on first script
//      execution; no ping exchange needed.
//   b. Client-driven: the inner app polls `{ type: 'oc-ping' }` (every
//      PING_INTERVAL_MS, up to PING_BUDGET_MS) until the host replies
//      `{ type: 'oc-init', shareBaseOrigin }` with a transferred MessagePort,
//      which the shim parks at `window.__oc.port`.
//
// All subsequent RPC and push traffic flows over that single port.

/**
 * Protocol version. Exported for documentation only — there is NO version field
 * on the wire today (`oc-init` carries none), so this is a marker of which
 * contract this package describes, not something negotiated at handshake. Wire
 * version negotiation is a host-side follow-up, not part of this contract.
 */
export const PROTOCOL_VERSION = 1

/**
 * Message `type` the inner app sends repeatedly to the host until it receives
 * the port. The host attaches its `message` listener and replies with
 * {@link OC_INIT} on the first ping it sees.
 */
export const OC_PING = 'oc-ping'

/**
 * Message `type` the host sends to the inner app, transferring the MessagePort.
 * Carries {@link OcInitMessage.shareBaseOrigin}; the port travels as the
 * transfer list, not in the message body.
 */
export const OC_INIT = 'oc-init'

/**
 * Interval, in milliseconds, between successive `oc-ping` messages while the
 * inner app waits for the port.
 */
export const PING_INTERVAL_MS = 100

/**
 * Total budget, in milliseconds, the inner app spends pinging before giving up
 * on the handshake.
 */
export const PING_BUDGET_MS = 5000

/**
 * Default per-request timeout, in milliseconds, applied by the transport when a
 * caller does not specify one. A request whose reply does not arrive within
 * this window rejects.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/**
 * Default timeout, in milliseconds, for RPCs that block on human-paced
 * interaction rather than pure machine round-trip time — today just
 * `kernel.signIn` (host-iframe's `signInWithPopup` gives a real OAuth popup up
 * to 90s to complete, see `packages/host-iframe/src/auth.ts`). `kernel.signOut`
 * deliberately stays on the generic {@link DEFAULT_REQUEST_TIMEOUT_MS} instead
 * — `signOutFlow` is one identity write and never waits on a human, so there's
 * no human-paced flow to budget extra time for (see `client.ts`'s
 * `auth.signOut`).
 *
 * {@link DEFAULT_REQUEST_TIMEOUT_MS} is tuned for ordinary machine-speed calls
 * (fs/db/git reads and writes) and is deliberately short so a truly stuck
 * request fails fast. Applying that same 30s budget to a call that wraps a
 * user typing their Google password was a real, always-reproducible bug: the
 * client gave up and reported a timeout while the popup — and the user — were
 * still working on a flow that can legitimately take longer than 30 seconds,
 * even on a good connection. Kept well above host-iframe's 90s popup ceiling
 * so the host's own give-up (which resolves cleanly to `null`/anonymous) is
 * always what the caller sees, not a client-side timeout racing ahead of it.
 */
export const DEFAULT_INTERACTIVE_TIMEOUT_MS = 120_000

/**
 * Default timeout, in milliseconds, for `ai.build` — the one RPC whose latency
 * is a whole build pipeline rather than a round trip. The median run takes tens
 * of seconds and a large one runs for minutes, so both
 * {@link DEFAULT_REQUEST_TIMEOUT_MS} (30s) and {@link DEFAULT_INTERACTIVE_TIMEOUT_MS}
 * (120s) would abandon builds that are working perfectly well — and abandoning
 * one is not free: the client posts a `cancel`, the host aborts the event
 * stream, and the caller sees a timeout for a job that goes on to succeed.
 *
 * 15 minutes is chosen to sit beyond any build we expect to be worth waiting
 * for rather than to model a typical one. It is a backstop against a stuck
 * stream, not a service-level target; a caller that wants to give up sooner
 * passes its own `opts.timeoutMs`. Note the streaming path re-arms this budget
 * on every progress delta, so it bounds SILENCE, not total build time — and the
 * host's own SSE watchdog (240s between bytes in `readSseStream`; mythcode sends
 * a keepalive every 15s) is the tighter bound on a dead stream, surfacing as
 * `ai.build failed: sse stream stalled`.
 */
export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60_000

/**
 * The `window` property the inner-app shim installs the received MessagePort
 * on. Code looks up `window.__oc?.port` to discover the live channel.
 */
export const OC_PORT_GLOBAL = '__oc'

/**
 * The ping message the inner app posts to the host's window during the
 * handshake. Sent via `window.parent.postMessage` (no port yet exists).
 */
export interface OcPingMessage {
  type: typeof OC_PING
}

/**
 * The host's handshake reply. Posted to the inner app's window with the
 * MessagePort in the transfer list. `shareBaseOrigin` is the OUTER host-frame
 * origin (the alias/canonical origin the page is served on) the inner app uses
 * to build share links — it never reaches back out to that origin, it only
 * reads the string. `initialPath` is the host's real top-level path at the
 * moment it created the iframe (deep link, refresh, or restored back/forward
 * state) — an app should boot its router there instead of always mounting at
 * `/`. Omitted on host builds that predate this field; the app falls back to
 * its own default route.
 */
export interface OcInitMessage {
  type: typeof OC_INIT
  shareBaseOrigin: string
  initialPath?: string
}

/**
 * Shape of the `window.__oc` global the inner-app shim maintains. `port` is the
 * MessagePort transferred via {@link OcInitMessage}, present once the handshake
 * completes. `initialPath` mirrors {@link OcInitMessage.initialPath};
 * `shareBaseOrigin` mirrors {@link OcInitMessage.shareBaseOrigin} so apps can
 * build share links off the OUTER host origin after the handshake settles.
 */
export interface OcGlobal {
  port?: MessagePort
  initialPath?: string
  shareBaseOrigin?: string
}
