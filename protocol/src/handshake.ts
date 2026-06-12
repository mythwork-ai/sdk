// Handshake constants + message shapes for acquiring the MessagePort.
//
// Verified against the deployed handshake in the monorepo:
//   - packages/orbit-shim-transport/src/index.ts (inner-app port discovery,
//     default request timeout)
//   - packages/host-iframe/src/db/index.ts (~lines 446-514: host sends oc-init
//     transferring the port; ping-driven retry loop)
//
// The flow: the inner app polls `{ type: 'oc-ping' }` (every PING_INTERVAL_MS,
// up to PING_BUDGET_MS) until the host replies `{ type: 'oc-init',
// shareBaseOrigin }` with a transferred MessagePort. The inner-app shim parks
// that port at `window.__oc.port` (see OC_PORT_GLOBAL / OcGlobal). All
// subsequent RPC and push traffic flows over that single port.

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
 * reads the string.
 */
export interface OcInitMessage {
  type: typeof OC_INIT
  shareBaseOrigin: string
}

/**
 * Shape of the `window.__oc` global the inner-app shim maintains. `port` is the
 * MessagePort transferred via {@link OcInitMessage}, present once the handshake
 * completes.
 */
export interface OcGlobal {
  port?: MessagePort
}
