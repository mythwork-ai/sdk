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
 * Message `type` the inner app posts to the host's WINDOW at the instant a
 * sign-in is clicked, so the host can open the OAuth popup while the browser
 * still credits the click.
 *
 * It exists because of how Safari decides a popup is user-initiated. WebKit's
 * `LocalDOMWindow::allowPopUp` consults `UserGestureIndicator::
 * processingUserGesture()` — a token that lives on the JS stack, not the
 * spec's per-window transient activation — and `MessagePort` delivery never
 * carries that token, so a `kernel.signIn` arriving over the RPC port reaches
 * the host with no gesture no matter how promptly it is served.
 * `window.postMessage` DOES carry it (`LocalDOMWindow::postMessage` captures
 * the current gesture and restores it on delivery, within a 1s forwarding
 * window), which is why this hint travels on the window and not the port.
 *
 * It is a hint, not a request: it carries no id, expects no reply, and the
 * real `kernel.signIn` RPC still follows over the port. A host that predates
 * it ignores an unknown window message, and a host that receives it without
 * the RPC ever arriving discards the reservation on a timer — so old and new
 * on either side degrade to exactly today's behaviour.
 */
export const OC_SIGNIN_GESTURE = 'oc-signin-gesture'

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
 * The wall-clock budget for one mythcode agent turn — the one thing whose
 * latency is a build pipeline, not a round trip. Read by the host's mythcode
 * engine (`turnDeadlineMs`), past which the turn ends with `reason: 'timeout'`.
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
 * The gesture hint the inner app posts to the host's window on a sign-in
 * click. Body-less by design — see {@link OC_SIGNIN_GESTURE}; the host
 * authenticates it by `MessageEvent.source`, exactly as it does `oc-ping`.
 */
export interface OcSignInGestureMessage {
  type: typeof OC_SIGNIN_GESTURE
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
