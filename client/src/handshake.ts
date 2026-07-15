// Port acquisition: getting the MessagePort the rest of the client talks over.
//
// Two paths, both faithful to deployed production behavior:
//
//   (a) THIS MODULE already verified a port earlier in the page's lifetime (a
//       prior `acquirePort()` call ran the real handshake below and confirmed
//       it came from the host). When that has happened (or is in flight), a
//       later call only needs to DISCOVER the already-verified port — poll
//       `window.__oc.port` and listen for `'ocready'`.
//
//   (b) No port has been verified yet. Then the client must run the handshake
//       ITSELF: post `{ type: 'oc-ping' }` to `window.parent` every
//       PING_INTERVAL_MS within PING_BUDGET_MS, listen for the host's
//       `{ type: 'oc-init', shareBaseOrigin }` reply carrying the transferred
//       MessagePort, install it at `window.__oc.port`, and dispatch the same
//       `'ocready'` event so any co-resident shim-transport converges on the
//       same port.
//
// The host replies with the port on the FIRST oc-ping it sees; either path's
// ping drives that reply.
//
// SECURITY: `window` delivers `'message'` events from ANY sender, not just the
// host — a sibling frame or an injected same-window script can post a
// same-shaped `{ type: 'oc-init' }` with its own transferred port and race the
// real host's reply. `onMessage` only ever adopts a port carried by a message
// whose `MessageEvent.source` is this frame's actual `window.parent` — a
// browser-set field a sender can never spoof, so this is the symmetric check
// to the host's own `e.source !== iframe.contentWindow` guard on its inbound
// `oc-ping` listener (`packages/host-iframe/src/db/index.ts`). It intentionally
// does not gate on `MessageEvent.origin`: the host frame's origin varies per
// deployment (custom domains), so this SDK has no fixed value to compare
// against; `source` identity gives the same guarantee without needing one.
//
// `window.__oc` is a plain, writable global, so its mere presence proves
// nothing: any same-window script (a compromised dependency, an ad/analytics
// snippet, an extension content script, XSS) can write a real MessagePort to
// `window.__oc.port` before `acquirePort()` ever runs. Path (a) must not treat
// "a MessagePort sits at window.__oc.port" as proof of host provenance — that
// would hand the attacker's port to every subsequent `fs.*`/`db.*`/`secrets.*`/
// `ai.*`/`kernel.*` call. Instead, provenance is tracked in `verifiedPorts`
// (module-private, in-memory, never exposed on `window`): a port is added to
// it ONLY inside `onMessage`, after the `isHostSource` check above passes.
// `detectPort()` — used by every "path (a)" read of the global, including the
// fast path, the `'ocready'` listener, the ping loop, and the final
// last-look — requires WeakSet membership, not just `instanceof MessagePort`.
// A pre-installed port that never went through the source-checked message flow
// is therefore never adopted via path (a); it just falls through to path (b),
// which re-verifies from scratch and ignores the forged value.
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
 * Ports this module has itself verified came from the host — added only
 * inside `onMessage`, after `isHostSource` confirms the transferring message's
 * `MessageEvent.source` is the real `window.parent`. This is the actual trust
 * boundary for path (a): a `window.__oc.port` value is module-private state
 * that any same-window script can overwrite, so its mere presence (or even
 * being a genuine `MessagePort` instance) proves nothing about who put it
 * there. Membership in this set is the only thing that does.
 */
const verifiedPorts = new WeakSet<MessagePort>()

/**
 * Read an already-installed port from the env's `window.__oc`, if present —
 * but only if THIS module previously verified it via the source-checked
 * `oc-init` message flow (see `verifiedPorts` above). A same-window script can
 * write any value, including a genuine `MessagePort`, to the plain
 * `window.__oc` global before `acquirePort()` runs; requiring `instanceof
 * MessagePort` alone would reject only an obviously-forged stand-in and still
 * adopt a real-but-unverified attacker-supplied port. Requiring
 * `verifiedPorts` membership closes that gap: an unverified value — forged or
 * not — is never adopted here, so `acquirePort()` falls through to running the
 * real, source-checked handshake itself (path (b)) instead.
 */
function detectPort(env: HandshakeEnv): MessagePort | null {
  const port = env.getOcGlobal()?.port
  return port instanceof MessagePort && verifiedPorts.has(port) ? port : null
}

/**
 * Read the app's boot path — the host's real top-level path at the moment it
 * created the iframe — from the negotiated `window.__oc` global. Only
 * meaningful once `connect()` has resolved: `undefined` means either no host
 * build has supplied one yet, or there is no host at all (dev/standalone).
 * Apps should navigate their router here on first mount instead of always
 * booting at `/`.
 */
export function getInitialPath(env: HandshakeEnv = browserEnv()): string | undefined {
  return env.getOcGlobal()?.initialPath
}

/**
 * Read the OUTER host-frame origin — the alias/canonical origin the page is
 * actually served on — from the negotiated `window.__oc` global, for building
 * share links. Only meaningful once `connect()` has resolved: `undefined`
 * means no host has supplied one (dev/standalone), and apps should fall back
 * to their own `location.origin`.
 */
export function getShareBaseOrigin(env: HandshakeEnv = browserEnv()): string | undefined {
  return env.getOcGlobal()?.shareBaseOrigin
}

/**
 * Acquire the host MessagePort, running whichever handshake path applies.
 *
 * Resolves with the started port (path (a): this module already verified it
 * via an earlier call in this page; path (b): we ran the oc-ping loop and the
 * host transferred it, with `MessageEvent.source` confirming the sender was
 * actually `window.parent`). Rejects with {@link NO_PORT_ERROR} if no port
 * appears within `timeoutMs`. The returned port is always `start()`-ed and
 * installed at `window.__oc.port`.
 */
export function acquirePort(env: HandshakeEnv, opts?: HandshakeOptions): Promise<MessagePort> {
  const budgetMs = opts?.timeoutMs ?? PING_BUDGET_MS

  // Fast path: a port this module already verified is sitting at
  // window.__oc.port (e.g. an earlier acquirePort() call in this same page
  // already ran the handshake). detectPort() only returns a WeakSet-verified
  // port, so a same-window script that pre-populated the global with its own
  // MessagePort before this call ran is never adopted here.
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

    // Path (a): a port this module already verified (see `verifiedPorts`)
    // dispatches 'ocready' once it's installed — either by this same
    // handshake's own `onMessage` below (a concurrent `acquirePort()` call in
    // this page converging on the port the first call just verified) or by an
    // earlier call that already ran. Same discovery path as
    // orbit-shim-transport.
    const onReady = () => {
      const port = detectPort(env)
      if (port) adopt(port)
    }

    // Path (b): we drive the handshake. The host replies oc-init transferring
    // the port; install it ourselves and announce via 'ocready'. Only ever
    // trust a reply whose `source` is the actual host window — otherwise any
    // sibling frame or injected script that races the real host's reply could
    // hand itself the RPC transport (see the SECURITY note at the top of this
    // file). This is also the ONLY place a port is ever added to
    // `verifiedPorts` — the sole source of provenance path (a) relies on, so a
    // port pre-installed at `window.__oc.port` by anything other than this
    // exact check is never trusted, no matter how genuine the MessagePort
    // instance looks.
    const onMessage = (e: Event) => {
      const me = e as MessageEvent
      // `source === window.parent` alone is not sufficient: a same-window
      // script already holds the real `window.parent` reference and can
      // construct `new MessageEvent('message', { source: window.parent, ... })`
      // and hand it to `window.dispatchEvent()` directly, skipping real
      // cross-document delivery entirely — the source check then passes
      // because the source object genuinely *is* `window.parent`, just not
      // delivered by the browser. `isTrusted` is the actual browser-enforced
      // signal that closes this: it is forced `true` only for events the
      // user agent itself dispatches (real DOM events, real cross-document
      // `postMessage` delivery) and cannot be set `true` by script-constructed
      // events, regardless of the calling code's privilege in this realm.
      if (!me.isTrusted) return
      if (!env.isHostSource(me.source)) return
      const d = me.data as {
        type?: string
        initialPath?: string
        shareBaseOrigin?: string
      } | null
      if (d?.type !== OC_INIT) return
      const port = me.ports?.[0]
      if (!port) return
      verifiedPorts.add(port)
      env.setOcGlobal({ port, initialPath: d.initialPath, shareBaseOrigin: d.shareBaseOrigin })
      env.dispatchEvent(new Event('ocready'))
      adopt(port)
    }

    env.addEventListener('ocready', onReady)
    env.addEventListener('message', onMessage)

    // Only run the ping loop when embedded — a top-level page has no host.
    if (env.hasParent()) {
      const ping = () => {
        if (settled) return
        // If a concurrent, already-verified handshake installed the port out
        // from under us, adopt it (detectPort() only ever returns a
        // WeakSet-verified port, never a merely-present global value).
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
