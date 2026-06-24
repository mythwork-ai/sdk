import { describe, expect, it, vi } from 'vitest'
import {
  type AuthEnv,
  type AuthFrame,
  type AuthUser,
  type ConnectAuthOptions,
  connectAuth,
} from './auth'

// Unit/integration tests for the top-level auth-consume bridge. A fake AuthEnv
// stands in for the DOM: `createFrame` returns a stub auth iframe that, on
// `init_auth`, plays the iframe SIDE of the contract — it adopts the
// transferred port (port2) and posts `ready` / `auth_success` / `logged_out`
// back exactly as workers/api routes/auth/auth-iframe.ts does. This proves the
// helper's read-side WITHOUT a deployed #357 or real Google: a real
// MessageChannel carries the messages, so the port plumbing is exercised end
// to end, only the cross-origin frame is stubbed.

const ORIGIN = 'https://auth.myth.work'

const USER: AuthUser = {
  userId: 'u_123',
  email: 'alice@example.com',
  name: 'Alice',
  picture: 'https://img.example/alice.png',
}

const TOKEN = 'jwt.session.token'

// A fixed macrotask wait. ONLY safe for the post-close negative: once the port
// is closed (port.close() + onmessage=null) no message can ever be delivered,
// so there's no anchor to poll for — we just give any erroneously-delivered
// message a tick to surface, then assert it didn't. Every other test polls via
// waitFor (below) instead, because a lone setTimeout(0) races MessagePort
// delivery and flaked under the shared-suite pool contention.
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

interface FakeIframeState {
  /** The init_auth message the helper posted to the frame. */
  initMessage: unknown
  /** The targetOrigin the helper pinned init_auth to. */
  initTargetOrigin: string | null
  /** The iframe's end of the MessageChannel (port2) once init_auth arrived. */
  iframePort: MessagePort | null
  removed: boolean
}

/**
 * A fake AuthEnv. The stub iframe plays the iframe side of the bridge: it
 * captures the init_auth post, grabs port2, and lets the test drive replies
 * over that port (or auto-replies if `autoReady` is set). `triggerLoad` fires
 * the frame's load handler so the handshake starts.
 */
function makeFakeEnv(opts?: {
  href?: string
  autoReady?: { loggedIn: boolean; user?: AuthUser | null; sessionToken?: string }
}): {
  env: AuthEnv
  state: FakeIframeState
  triggerLoad: () => void
  /** Post a message from the iframe side over its port. */
  iframePost: (message: unknown) => void
  assignedUrls: string[]
} {
  const state: FakeIframeState = {
    initMessage: null,
    initTargetOrigin: null,
    iframePort: null,
    removed: false,
  }
  const assignedUrls: string[] = []
  let loadHandler: (() => void) | null = null

  const frame: AuthFrame = {
    post: (message, targetOrigin, transfer) => {
      state.initMessage = message
      state.initTargetOrigin = targetOrigin
      // The browser would deliver the transferred port to the frame. Emulate
      // the iframe receiving port2 and wiring its own onmessage if autoReady.
      const port = transfer[0] as MessagePort
      state.iframePort = port
      port.start()
      if (opts?.autoReady) {
        const { loggedIn, user, sessionToken } = opts.autoReady
        port.postMessage({
          type: 'ready',
          loggedIn,
          userId: user ? user.userId : null,
          user: user ?? null,
          sessionToken: sessionToken ?? null,
        })
      }
    },
    onLoad: handler => {
      loadHandler = handler
    },
    remove: () => {
      state.removed = true
    },
  }

  const env: AuthEnv = {
    createFrame: () => frame,
    createChannel: () => new MessageChannel(),
    currentHref: () => opts?.href ?? 'https://landing.myth.work/dashboard',
    assignLocation: url => {
      assignedUrls.push(url)
    },
  }

  return {
    env,
    state,
    triggerLoad: () => loadHandler?.(),
    iframePost: message => state.iframePort?.postMessage(message),
    assignedUrls,
  }
}

const connectOpts = (env: AuthEnv): ConnectAuthOptions => ({ authOrigin: ORIGIN, env })

// MessagePort delivery is async and (under the shared SDK suite, after the
// happy-dom React tests) can span more than one macrotask. So DON'T rely on a
// fixed tick — poll the condition until it holds (deterministic regardless of
// how many ticks delivery actually takes). MessagePort preserves order, so a
// SENTINEL message posted after the message-under-test is the anchor for
// asserting a NEGATIVE: once the sentinel's effect lands, every earlier message
// has already been delivered + handled.
const SENTINEL_TOKEN = 'jwt.__sentinel__'
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never held')
    await new Promise<void>(r => setTimeout(r, 1))
  }
}

describe('connectAuth — handshake + ready', () => {
  it('frames authOrigin/ and posts init_auth pinned to authOrigin on load', () => {
    const f = makeFakeEnv()
    connectAuth(connectOpts(f.env))
    // No handshake until the frame loads.
    expect(f.state.initMessage).toBeNull()
    f.triggerLoad()
    expect(f.state.initMessage).toEqual({ type: 'init_auth' })
    // SECURITY: init_auth (carrying the transferred port) is pinned to
    // authOrigin so only a frame that actually loaded authOrigin gets the port.
    expect(f.state.initTargetOrigin).toBe(ORIGIN)
  })

  it('reflects a signed-in ready{loggedIn:true,user,sessionToken} into getUser/getSessionToken', async () => {
    const f = makeFakeEnv({ autoReady: { loggedIn: true, user: USER, sessionToken: TOKEN } })
    const auth = connectAuth(connectOpts(f.env))
    f.triggerLoad()
    await waitFor(() => auth.getUser() !== null)
    expect(auth.getUser()).toEqual(USER)
    expect(auth.getSessionToken()).toBe(TOKEN)
  })

  it('onAuthChange replays current (null) immediately, then fires with the user on ready', async () => {
    const f = makeFakeEnv({ autoReady: { loggedIn: true, user: USER, sessionToken: TOKEN } })
    const auth = connectAuth(connectOpts(f.env))
    const seen: (AuthUser | null)[] = []
    auth.onAuthChange(u => seen.push(u))
    // Immediate replay before any bridge message.
    expect(seen).toEqual([null])
    f.triggerLoad()
    await waitFor(() => seen.length >= 2)
    expect(seen).toEqual([null, USER])
    // The session token is set BEFORE the callback fires (ordering contract).
    expect(auth.getSessionToken()).toBe(TOKEN)
  })

  it('a logged-out ready{loggedIn:false} leaves user null and does not fire callbacks again', async () => {
    const f = makeFakeEnv({ autoReady: { loggedIn: false } })
    const auth = connectAuth(connectOpts(f.env))
    const seen: (AuthUser | null)[] = []
    auth.onAuthChange(u => seen.push(u))
    f.triggerLoad()
    // A logged-out ready changes nothing observable, so anchor on a sentinel
    // posted AFTER it: once the token rotates, the ready has been handled.
    f.iframePost({ type: 'session_refreshed', sessionToken: SENTINEL_TOKEN })
    await waitFor(() => auth.getSessionToken() === SENTINEL_TOKEN)
    expect(auth.getUser()).toBeNull()
    // Only the immediate replay; no spurious change for a logged-out ready.
    expect(seen).toEqual([null])
  })
})

describe('connectAuth — session_status / auth_success / logged_out', () => {
  it('session_status carrying a session updates user + token (same shape as ready)', async () => {
    const f = makeFakeEnv()
    const auth = connectAuth(connectOpts(f.env))
    f.triggerLoad()
    f.iframePost({
      type: 'session_status',
      loggedIn: true,
      userId: USER.userId,
      user: USER,
      sessionToken: TOKEN,
    })
    await waitFor(() => auth.getUser() !== null)
    expect(auth.getUser()).toEqual(USER)
    expect(auth.getSessionToken()).toBe(TOKEN)
  })

  it('auth_success after sign-in sets the user + token and notifies', async () => {
    const f = makeFakeEnv({ autoReady: { loggedIn: false } })
    const auth = connectAuth(connectOpts(f.env))
    const seen: (AuthUser | null)[] = []
    auth.onAuthChange(u => seen.push(u))
    f.triggerLoad()
    // ready{loggedIn:false} (fires no callback) and auth_success ride the same
    // ordered port, so polling on the auth_success effect proves both landed.
    f.iframePost({ type: 'auth_success', user: USER, sessionToken: TOKEN })
    await waitFor(() => auth.getUser() !== null)
    expect(auth.getUser()).toEqual(USER)
    expect(auth.getSessionToken()).toBe(TOKEN)
    expect(seen).toEqual([null, USER])
  })

  it('logged_out clears the user + token and notifies subscribers', async () => {
    const f = makeFakeEnv({ autoReady: { loggedIn: true, user: USER, sessionToken: TOKEN } })
    const auth = connectAuth(connectOpts(f.env))
    const seen: (AuthUser | null)[] = []
    auth.onAuthChange(u => seen.push(u))
    f.triggerLoad()
    await waitFor(() => auth.getUser() !== null)
    expect(auth.getUser()).toEqual(USER)

    f.iframePost({ type: 'logged_out' })
    await waitFor(() => auth.getUser() === null)
    expect(auth.getUser()).toBeNull()
    expect(auth.getSessionToken()).toBeNull()
    expect(seen).toEqual([null, USER, null])
  })

  it('session_refreshed rotates the token without touching the user or notifying', async () => {
    const f = makeFakeEnv({ autoReady: { loggedIn: true, user: USER, sessionToken: TOKEN } })
    const auth = connectAuth(connectOpts(f.env))
    const seen: (AuthUser | null)[] = []
    auth.onAuthChange(u => seen.push(u))
    f.triggerLoad()
    // ready (sets USER/TOKEN) and session_refreshed ride the same ordered port;
    // polling on the rotated token proves the ready landed first.
    f.iframePost({ type: 'session_refreshed', sessionToken: 'jwt.rotated' })
    await waitFor(() => auth.getSessionToken() === 'jwt.rotated')
    expect(auth.getSessionToken()).toBe('jwt.rotated')
    expect(auth.getUser()).toEqual(USER)
    // No auth-change fired for a pure token rotation.
    expect(seen).toEqual([null, USER])
  })

  it('ignores non-session messages (auth_error / prompt_failed / unknown)', async () => {
    const f = makeFakeEnv({ autoReady: { loggedIn: true, user: USER, sessionToken: TOKEN } })
    const auth = connectAuth(connectOpts(f.env))
    f.triggerLoad()
    f.iframePost({ type: 'auth_error', error: 'boom' })
    f.iframePost({ type: 'prompt_failed' })
    f.iframePost({ type: 'totally_unknown' })
    // None of these carry a session, so they change nothing observable. Anchor
    // on a sentinel posted AFTER them: once its token rotation lands, all three
    // junk messages (and the earlier ready) have been delivered + handled.
    f.iframePost({ type: 'session_refreshed', sessionToken: SENTINEL_TOKEN })
    await waitFor(() => auth.getSessionToken() === SENTINEL_TOKEN)
    // User survived the junk untouched; only the sentinel's rotation took.
    expect(auth.getUser()).toEqual(USER)
  })
})

describe('connectAuth — signIn redirect', () => {
  it('redirects to authOrigin/signin?return_to=<current href> by default', () => {
    const href = 'https://landing.myth.work/dashboard?x=1'
    const f = makeFakeEnv({ href })
    const auth = connectAuth(connectOpts(f.env))
    auth.signIn()
    expect(f.assignedUrls).toEqual([`${ORIGIN}/signin?return_to=${encodeURIComponent(href)}`])
  })

  it('redirects with an explicit return_to when provided, URL-encoded', () => {
    const f = makeFakeEnv()
    const auth = connectAuth(connectOpts(f.env))
    const explicit = 'https://app.myth.work/p/abc?tab=settings&q=a b'
    auth.signIn(explicit)
    expect(f.assignedUrls).toEqual([`${ORIGIN}/signin?return_to=${encodeURIComponent(explicit)}`])
    // No token, no session ever rides in the URL — only return_to.
    expect(f.assignedUrls[0]).not.toContain('jwt')
    expect(f.assignedUrls[0]).not.toContain(TOKEN)
  })
})

describe('connectAuth — signOut + close', () => {
  it('signOut posts {type:"logout"} to the iframe, which replies logged_out', async () => {
    const f = makeFakeEnv({ autoReady: { loggedIn: true, user: USER, sessionToken: TOKEN } })
    const auth = connectAuth(connectOpts(f.env))
    f.triggerLoad()
    await waitFor(() => auth.getUser() !== null)
    // The iframe side answers a logout by clearing + posting logged_out.
    f.state.iframePort!.onmessage = (e: MessageEvent) => {
      if ((e.data as { type?: string }).type === 'logout') {
        f.iframePost({ type: 'logged_out' })
      }
    }
    auth.signOut()
    await waitFor(() => auth.getUser() === null)
    expect(auth.getUser()).toBeNull()
    expect(auth.getSessionToken()).toBeNull()
  })

  it('signOut before the port is up clears local state immediately', () => {
    const f = makeFakeEnv()
    const auth = connectAuth(connectOpts(f.env))
    // No triggerLoad → no port yet.
    const seen: (AuthUser | null)[] = []
    auth.onAuthChange(u => seen.push(u))
    auth.signOut()
    expect(auth.getUser()).toBeNull()
    // Replay(null) + the explicit clear(null).
    expect(seen).toEqual([null, null])
  })

  it('close() removes the frame and is idempotent', () => {
    const f = makeFakeEnv()
    const auth = connectAuth(connectOpts(f.env))
    f.triggerLoad()
    auth.close()
    expect(f.state.removed).toBe(true)
    // Second close is a no-op (no throw).
    expect(() => auth.close()).not.toThrow()
  })

  it('messages arriving after close() are ignored (port closed)', async () => {
    const f = makeFakeEnv()
    const auth = connectAuth(connectOpts(f.env))
    f.triggerLoad()
    auth.close()
    f.iframePost({ type: 'ready', loggedIn: true, user: USER, sessionToken: TOKEN })
    await flush()
    expect(auth.getUser()).toBeNull()
  })
})

describe('browserAuthEnv', () => {
  it('throws a clear error outside a DOM context', async () => {
    // The node test env has no window/document.
    const { browserAuthEnv } = await import('./auth')
    expect(() => browserAuthEnv()).toThrow(/browser DOM/)
  })
})

describe('connectAuth — unsubscribe', () => {
  it('onAuthChange returns an unsubscribe that detaches the callback', async () => {
    const f = makeFakeEnv()
    const auth = connectAuth(connectOpts(f.env))
    const cb = vi.fn()
    const off = auth.onAuthChange(cb)
    expect(cb).toHaveBeenCalledTimes(1) // replay
    off()
    f.triggerLoad()
    f.iframePost({ type: 'ready', loggedIn: true, user: USER, sessionToken: TOKEN })
    // cb is detached, so anchor on observable state: once the ready's token
    // lands, the ready (and any callback it would have fired) has been handled.
    await waitFor(() => auth.getSessionToken() === TOKEN)
    // Still only the replay — detached before the change.
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
