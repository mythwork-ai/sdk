// Port acquisition: getting the MessagePort the rest of the client talks over.
//
// Two paths, both faithful to deployed production behavior:
//
//   (a) A platform bootstrap already ran. The serve-worker injected the
//       orbit-shim, which ran the oc-ping loop, installed the transferred port
//       at `window.__oc.port`, and dispatched a `'ocready'` window Event. When
//       that has happened (or is in flight), the client only needs to DISCOVER
//       the port — poll `window.__oc.port` and listen for `'ocready'`.
//
//   (b) No platform bootstrap installed a port. Then the client must run the
//       handshake ITSELF: post `{ type: 'oc-ping' }` to `window.parent` every
//       PING_INTERVAL_MS within PING_BUDGET_MS, listen for the host's
//       `{ type: 'oc-init', shareBaseOrigin }` reply carrying the transferred
//       MessagePort, install it at `window.__oc.port`, and dispatch the same
//       `'ocready'` event the platform fires — so any co-resident shim-transport
//       converges on the same port.
//
// The host replies with the port on the FIRST oc-ping it sees; either path's
// ping drives that reply.
//
// SECURITY: `window` delivers `'message'` events from ANY sender, not just the
// host — a sibling frame or an injected same-window script can post a
// same-shaped `{ type: 'oc-init' }` with its own transferred port and race the
// real host's reply. `onMessage` (path (b)) only ever adopts a port carried by
// a message whose `MessageEvent.source` is this frame's actual `window.parent`
// — a browser-set field a sender can never spoof, so this is the symmetric
// check to the host's own `e.source !== iframe.contentWindow` guard on its
// inbound `oc-ping` listener (`host-iframe/src/db/index.ts`). It intentionally
// does not gate on `MessageEvent.origin`: the host frame's origin varies per
// deployment (custom domains), so this SDK has no fixed value to compare
// against; `source` identity gives the same guarantee without needing one.
//
// Everything reaches `window`/`MessagePort` through an injectable {@link
// HandshakeEnv} seam so the state machine is unit-testable with a minimal
// EventTarget shim rather than real globals.

import {
  OC_INIT,
  OC_PING,
  OC_PORT_GLOBAL,
  type OcGlobal,
  PING_BUDGET_MS,
  PING_INTERVAL_MS,
} from '@mythwork/protocol'

/**
 * The slice of the DOM the handshake touches, abstracted so tests can supply a
 * fake. In production {@link browserEnv} binds these to the real `window`.
 */
export interface HandshakeEnv {
  /** Add a `'message'` / `'ocready'` listener (the window's `addEventListener`). */
  addEventListener(type: string, listener: (e: Event) => void): void
  /** Remove a previously added listener. */
  removeEventListener(type: string, listener: (e: Event) => void): void
  /** Dispatch a window Event (used to fire `'ocready'` after we install a port). */
  dispatchEvent(event: Event): void
  /** Post a message to the host (the parent frame). Path (b) sends oc-ping here. */
  postToHost(message: unknown): void
  /** Read the currently-installed `window.__oc` global, if any. */
  getOcGlobal(): OcGlobal | undefined
  /** Install the acquired port at `window.__oc.port`. */
  setOcGlobal(value: OcGlobal): void
  /** True when this frame is embedded (has a distinct parent to ping). */
  hasParent(): boolean
  /**
   * True when `source` (a `MessageEvent.source`) is this frame's actual host
   * window (`window.parent`) — the only sender an `oc-init` reply is trusted
   * from. `source` is set by the browser on delivery and cannot be forged by
   * the sender, unlike the message body.
   */
  isHostSource(source: unknown): boolean
}

/** Options accepted by {@link acquirePort} / `connect`. */
export interface HandshakeOptions {
  /**
   * Total budget, in milliseconds, to spend acquiring the port before
   * rejecting. Defaults to {@link PING_BUDGET_MS}.
   */
  timeoutMs?: number
}

/** Error message used when no host port appears within the budget. */
export const NO_PORT_ERROR =
  '@mythwork/sdk: no host-frame port. Apps must run inside a Mythwork host frame.'

/**
 * Bind a {@link HandshakeEnv} to the real browser `window`/`window.parent`.
 * Throws if called outside a DOM context (no `window`).
 */
export function browserEnv(): HandshakeEnv {
  if (typeof window === 'undefined') {
    throw new Error('@mythwork/sdk: connect() requires a browser window (no window global found).')
  }
  const w = window as unknown as {
    addEventListener: Window['addEventListener']
    removeEventListener: Window['removeEventListener']
    dispatchEvent: Window['dispatchEvent']
    parent: Window
    [OC_PORT_GLOBAL]?: OcGlobal
  }
  return {
    addEventListener: (type, listener) => w.addEventListener(type, listener),
    removeEventListener: (type, listener) => w.removeEventListener(type, listener),
    dispatchEvent: event => w.dispatchEvent(event),
    postToHost: message => w.parent.postMessage(message, '*'),
    getOcGlobal: () => w[OC_PORT_GLOBAL],
    setOcGlobal: value => {
      w[OC_PORT_GLOBAL] = value
    },
    hasParent: () => w.parent !== (w as unknown as Window),
    isHostSource: source => source === w.parent,
  }
}

/**
 * Read an already-installed port from the env's `window.__oc`, if present.
 * Requires a genuine `MessagePort` instance — a same-window script can write
 * to the plain `window.__oc` global before `connect()` runs, so this at least
 * rejects an obviously-forged, non-transferable stand-in. It cannot establish
 * full provenance (nothing about a bare global read carries sender identity);
 * the enforceable trust boundary is the `isHostSource` check on the live
 * `oc-init` reply below.
 */
function detectPort(env: HandshakeEnv): MessagePort | null {
  const port = env.getOcGlobal()?.port
  return port instanceof MessagePort ? port : null
}

/**
 * Acquire the host MessagePort, running whichever handshake path applies.
 *
 * Resolves with the started port (path (a): a platform bootstrap installed it;
 * path (b): we ran the oc-ping loop and the host transferred it). Rejects with
 * {@link NO_PORT_ERROR} if no port appears within `timeoutMs`. The returned port
 * is always `start()`-ed and installed at `window.__oc.port`.
 */
export function acquirePort(env: HandshakeEnv, opts?: HandshakeOptions): Promise<MessagePort> {
  const budgetMs = opts?.timeoutMs ?? PING_BUDGET_MS

  // Fast path: a port is already installed (platform bootstrap finished first).
  const existing = detectPort(env)
  if (existing) {
    existing.start()
    return Promise.resolve(existing)
  }

  return new Promise<MessagePort>((resolve, reject) => {
    let settled = false
    let pingTimer: ReturnType<typeof setInterval> | null = null
    let budgetTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      env.removeEventListener('ocready', onReady)
      env.removeEventListener('message', onMessage)
      if (pingTimer) clearInterval(pingTimer)
      if (budgetTimer) clearTimeout(budgetTimer)
    }

    const adopt = (port: MessagePort) => {
      if (settled) return
      settled = true
      cleanup()
      port.start()
      // Install + announce so a co-resident shim-transport converges on this
      // same port.
      if (!env.getOcGlobal()?.port) env.setOcGlobal({ port })
      resolve(port)
    }

    // Path (a): the platform bootstrap dispatches 'ocready' once it installs
    // window.__oc.port. Same discovery path as orbit-shim-transport.
    const onReady = () => {
      const port = detectPort(env)
      if (port) adopt(port)
    }

    // Path (b): we drive the handshake. The host replies oc-init transferring
    // the port; install it ourselves and announce via 'ocready'. Only ever
    // trust a reply whose `source` is the actual host window — otherwise any
    // sibling frame or injected script that races the real host's reply could
    // hand itself the RPC transport (see the SECURITY note at the top of this
    // file).
    const onMessage = (e: Event) => {
      const me = e as MessageEvent
      if (!env.isHostSource(me.source)) return
      const d = me.data as { type?: string } | null
      if (d?.type !== OC_INIT) return
      const port = me.ports?.[0]
      if (!port) return
      env.setOcGlobal({ port })
      env.dispatchEvent(new Event('ocready'))
      adopt(port)
    }

    env.addEventListener('ocready', onReady)
    env.addEventListener('message', onMessage)

    // Only run the ping loop when embedded — a top-level page has no host.
    if (env.hasParent()) {
      const ping = () => {
        if (settled) return
        // If a bootstrap installed the port out from under us, adopt it.
        const port = detectPort(env)
        if (port) {
          adopt(port)
          return
        }
        env.postToHost({ type: OC_PING })
      }
      ping()
      pingTimer = setInterval(ping, PING_INTERVAL_MS)
    }

    budgetTimer = setTimeout(() => {
      if (settled) return
      // Last look before giving up — covers a port installed right at the edge.
      const port = detectPort(env)
      if (port) {
        adopt(port)
        return
      }
      settled = true
      cleanup()
      reject(new Error(NO_PORT_ERROR))
    }, budgetMs)
  })
}
