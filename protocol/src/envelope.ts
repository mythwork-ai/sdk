// The wire envelope: the three message shapes that travel over the
// host <-> inner-app MessagePort. Verified against the deployed transport in
// the monorepo (packages/orbit-shim-transport/src/index.ts) — the host frame
// sees a single correlated stream, so requests and responses share one channel
// with id correlation, and pushes are id-less.

/**
 * A request the inner app sends to the host. `id` correlates the eventual
 * {@link RpcResponse}; `method` is the wire method string (a key of
 * `MethodMap`); `args` carries the method's params. Values may include
 * `Uint8Array` and other structured-clone-able data — this is postMessage, not
 * JSON, so binary payloads ride through directly.
 */
export interface RpcRequest {
  id: string
  method: string
  args: Record<string, unknown>
}

/**
 * The host's reply to an {@link RpcRequest}, matched back by the same `id`.
 * Exactly one of `result` / `error` is meaningful: `error` (a string message)
 * is present on failure and `result` is absent; on success `result` holds the
 * method's result (possibly `undefined` for void-like methods) and `error` is
 * absent.
 */
export interface RpcResponse {
  id: string
  result?: unknown
  error?: string
}

/**
 * A host -> app push notification. Unlike an {@link RpcResponse} it carries NO
 * `id` (that absence is how the transport tells pushes apart from replies); the
 * `type` field names the event (a key of `EventMap`) and the remaining fields
 * are the event payload. Subscriptions are prefix-matched: a subscriber to
 * `'fs'` receives both `'fs'` and any `'fs.*'` push.
 */
export interface PushMessage {
  type: string
  [key: string]: unknown
}
