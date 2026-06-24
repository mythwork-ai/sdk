// Top-level auth-consume: obtain + use the platform session from a page that has
// NO host frame (the landing site, a served app's own chrome, etc).
//
// The session lives host-only on `auth.{zone}` (no Domain attribute), so a
// top-level page can NEVER read it from `document.cookie`. The ONLY way to learn
// the session is the auth-iframe postMessage bridge: frame `auth.{zone}/`, run
// the `init_auth` MessageChannel handshake, and read the session the iframe
// reports back (`ready` / `session_status` carrying `{loggedIn, sessionToken,
// user}`). This module is the top-level read-side of that bridge — the same
// protocol the host frame's reference consumer (packages/host-iframe/src/auth.ts)
// speaks, ported here without the One-Tap/popup machinery a host frame needs.
//
// Sign-in is a TOP-LEVEL redirect to `auth.{zone}/signin?return_to=<self>`
// (workers/api routes/auth/signin.ts): Google OAuth establishes the host-only
// session cookie on `auth.{zone}` and 302s back. No token ever rides in a URL.
// After the redirect returns, the page re-runs the bridge handshake and the
// iframe reports the now-established session.
//
// SECURITY: inbound port/window messages are accepted ONLY from `authOrigin`.
// The iframe side enforces its own parent-origin allowlist; this is the
// symmetric check so a top-level page never trusts a frame it didn't create.

/**
 * The user identity delivered over the auth-iframe bridge — the `/google` +
 * `/google/callback` response user (and, on a returning load, the Bearer-authed
 * `/me` record). Matches `PublicUser` (workers/api routes/auth/google.ts) and
 * the reference consumer's `AuthUser` (packages/host-iframe/src/auth.ts).
 * Distinct from the protocol's host-RPC `User` union (`kernel.getUser`); this
 * is the auth-bridge wire shape.
 */
export interface AuthUser {
  userId: string
  email: string
  name: string
  picture: string | null
}

/** Callback for {@link AuthConsumer.onAuthChange}; receives the current user (or null when signed out). */
export type AuthChangeCallback = (user: AuthUser | null) => void

/** The top-level auth-consume surface returned by {@link connectAuth}. */
export interface AuthConsumer {
  /** The current signed-in user, or `null` until/unless the bridge reports one. */
  getUser(): AuthUser | null
  /** The current session JWT, or `null`. Bearer for authenticated API calls. */
  getSessionToken(): string | null
  /**
   * Subscribe to auth-state changes. Fires immediately with the current user
   * (replay), then on every subsequent change. Returns an unsubscribe fn.
   */
  onAuthChange(callback: AuthChangeCallback): () => void
  /**
   * Begin sign-in: a TOP-LEVEL redirect to `auth.{zone}/signin?return_to=<url>`.
   * Defaults `return_to` to the current page so the user lands back where they
   * started, now signed in (the session is read via the bridge on return).
   */
  signIn(returnTo?: string): void
  /** Sign out: tell the auth iframe to clear the session, then clears local state. */
  signOut(): void
  /** Tear down the iframe + listeners. Idempotent. */
  close(): void
}

/** Options for {@link connectAuth}. */
export interface ConnectAuthOptions {
  /**
   * Origin serving the auth iframe + the `/signin` entry, e.g.
   * `https://auth.myth.work`. The iframe is framed at `${authOrigin}/` and
   * sign-in redirects to `${authOrigin}/signin`. Inbound bridge messages are
   * accepted ONLY from this origin.
   */
  authOrigin: string
  /**
   * Override the DOM environment the bridge runs against. Defaults to the real
   * browser `window`/`document` ({@link browserAuthEnv}). A testing seam — a
   * fake env can stub the iframe's `contentWindow` so the handshake runs without
   * a real cross-origin frame.
   */
  env?: AuthEnv
}

// ── injectable DOM seam ──────────────────────────────────────────────────────

/** A child frame the helper drives: post `init_auth` to it, listen for its load. */
export interface AuthFrame {
  /** Post a message (the `init_auth` handshake, with the transferred port) to the frame. */
  post(message: unknown, targetOrigin: string, transfer: Transferable[]): void
  /** Register the frame's `load` handler (the handshake starts on load). */
  onLoad(handler: () => void): void
  /** Remove the frame from the document. */
  remove(): void
}

/**
 * The slice of the DOM the auth bridge touches, abstracted so tests can supply a
 * fake (no real cross-origin iframe needed). {@link browserAuthEnv} binds these
 * to the real `window`/`document`.
 */
export interface AuthEnv {
  /** Create the hidden auth iframe at `src` and return a handle to it. */
  createFrame(src: string): AuthFrame
  /** Create a MessageChannel (port1 is the parent's end). */
  createChannel(): MessageChannel
  /** The current top-level URL — the default `return_to` for {@link AuthConsumer.signIn}. */
  currentHref(): string
  /** Navigate the top-level page (the sign-in redirect). */
  assignLocation(url: string): void
}

/**
 * Bind an {@link AuthEnv} to the real browser `window`/`document`. Throws if
 * called outside a DOM context (no `window`/`document`).
 */
export function browserAuthEnv(): AuthEnv {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error(
      '@mythwork/sdk: connectAuth() requires a browser DOM (no window/document found).',
    )
  }
  return {
    createFrame(src: string): AuthFrame {
      const iframe = document.createElement('iframe')
      iframe.id = 'mythwork-auth-frame'
      iframe.src = src
      // Required so the embedded Google One-Tap / FedCM flow can run.
      iframe.allow = 'identity-credentials-get'
      iframe.style.display = 'none'
      document.body.appendChild(iframe)
      return {
        post: (message, targetOrigin, transfer) => {
          // contentWindow is non-null once appended; the handshake only posts
          // from the load handler, by which point it is guaranteed present.
          iframe.contentWindow?.postMessage(message, targetOrigin, transfer)
        },
        onLoad: handler => {
          iframe.addEventListener('load', handler)
        },
        remove: () => {
          iframe.remove()
        },
      }
    },
    createChannel: () => new MessageChannel(),
    currentHref: () => window.location.href,
    assignLocation: url => {
      window.location.assign(url)
    },
  }
}

// ── bridge message shapes (read-side of the auth-iframe contract) ─────────────

/**
 * Messages the auth iframe posts back over the port. Exactly the contract
 * served by workers/api routes/auth/auth-iframe.ts and consumed by
 * packages/host-iframe/src/auth.ts — do not invent new types here.
 */
interface AuthIframeMessage {
  type?:
    | 'ready'
    | 'session_status'
    | 'auth_success'
    | 'session_refreshed'
    | 'logged_out'
    | 'auth_error'
    | 'prompt_failed'
    | 'session_refresh_failed'
  loggedIn?: boolean
  sessionToken?: string
  user?: AuthUser | null
  userId?: string
}

/**
 * Connect a top-level page to the platform session via the auth-iframe bridge.
 *
 * Frames `${authOrigin}/`, performs the `init_auth` MessageChannel handshake,
 * and reflects the session the iframe reports (`ready` / `session_status` /
 * `auth_success` / `logged_out`) into `getUser()` / `getSessionToken()` /
 * `onAuthChange()`. `signIn()` redirects top-level to the `/signin` entry.
 *
 * Pure read-side: this never reads `document.cookie` (the session is host-only
 * on `authOrigin`) and never puts a token in a URL.
 */
export function connectAuth(opts: ConnectAuthOptions): AuthConsumer {
  const { authOrigin } = opts
  const env = opts.env ?? browserAuthEnv()

  let port: MessagePort | null = null
  let currentUser: AuthUser | null = null
  let currentSessionToken: string | null = null
  let closed = false
  const callbacks: AuthChangeCallback[] = []

  const notify = (): void => {
    for (const cb of callbacks) cb(currentUser)
  }

  // ready / session_status: the iframe atomically reports the cookie-derived
  // session. The token is assigned BEFORE callbacks fire so a listener that
  // immediately reads getSessionToken() sees it (mirrors the reference
  // consumer's handleReadyMessage ordering).
  const handleReady = (data: AuthIframeMessage): void => {
    if (data.sessionToken) currentSessionToken = data.sessionToken
    if (data.loggedIn && (data.user || data.userId)) {
      currentUser = data.user ?? currentUser
      notify()
    }
  }

  const handleAuthSuccess = (data: AuthIframeMessage): void => {
    if (!data.user) return
    currentUser = data.user
    if (data.sessionToken) currentSessionToken = data.sessionToken
    notify()
  }

  const handleLoggedOut = (): void => {
    currentUser = null
    currentSessionToken = null
    notify()
  }

  const handleMessage = (data: AuthIframeMessage): void => {
    switch (data.type) {
      case 'ready':
      case 'session_status':
        handleReady(data)
        return
      case 'auth_success':
        handleAuthSuccess(data)
        return
      case 'session_refreshed':
        if (data.sessionToken) currentSessionToken = data.sessionToken
        return
      case 'logged_out':
        handleLoggedOut()
        return
      default:
        // auth_error / prompt_failed / session_refresh_failed and any unknown
        // type carry no session to adopt — ignore. A top-level page has no
        // One-Tap popup fallback, so prompt_failed is a no-op here.
        return
    }
  }

  const frame = env.createFrame(`${authOrigin}/`)
  frame.onLoad(() => {
    if (closed) return
    const channel = env.createChannel()
    port = channel.port1
    port.onmessage = (e: MessageEvent) => {
      // Port messages arrive only from the frame we created, but a port is a
      // capability; we still gate on the documented contract by shape. (The
      // iframe enforces its own parent-origin allowlist; origin checking on the
      // top-level page applies to the init handshake target, which we pin to
      // authOrigin in the post below.)
      handleMessage(e.data as AuthIframeMessage)
    }
    // Pin the target origin to authOrigin: the browser delivers init_auth (and
    // the transferred port) ONLY if the frame's origin matches, so a frame that
    // somehow loaded a different origin never receives our port.
    frame.post({ type: 'init_auth' }, authOrigin, [channel.port2])
  })

  return {
    getUser: () => currentUser,
    getSessionToken: () => currentSessionToken,
    onAuthChange(callback: AuthChangeCallback) {
      callbacks.push(callback)
      callback(currentUser)
      return () => {
        const i = callbacks.indexOf(callback)
        if (i !== -1) callbacks.splice(i, 1)
      }
    },
    signIn(returnTo?: string) {
      const target = returnTo ?? env.currentHref()
      env.assignLocation(`${authOrigin}/signin?return_to=${encodeURIComponent(target)}`)
    },
    signOut() {
      // Ask the iframe to clear the host-only session; it replies `logged_out`,
      // which clears local state via handleMessage. If the port isn't up yet,
      // clear locally so the UI reflects the intent immediately.
      if (port) port.postMessage({ type: 'logout' })
      else handleLoggedOut()
    },
    close() {
      if (closed) return
      closed = true
      if (port) {
        port.onmessage = null
        port.close()
        port = null
      }
      frame.remove()
    },
  }
}
