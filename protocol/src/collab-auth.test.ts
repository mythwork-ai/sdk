import { describe, expect, it, vi } from 'vitest'
import {
  type CollabProviderLike,
  JOIN_TOKEN_SAFETY_MS,
  MAX_REFRESH_FAILURES,
  MINT_TIMEOUT_MS,
  type ProviderEventName,
  type ProviderStateEvents,
  RECONNECT_BACKOFF_JITTER,
  RECONNECT_MAX_BACKOFF_MS,
  readJoinTokenExp,
  reconnectMaxBackoffMs,
  wireJoinTokenRefresh,
} from './collab-auth'

/**
 * Mint a token in the real wire shape (`b64url(JSON body).b64url(sig)`, body
 * `{ rid, exp, w }`) so `readJoinTokenExp` is exercised against the format the
 * api worker actually emits rather than a convenient stand-in. The signature is
 * a placeholder — nothing client-side verifies it.
 */
function mintToken(expMs: number, rid = 'r-room'): string {
  const body = JSON.stringify({ rid, exp: expMs, w: true })
  const b64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64}.c2ln`
}

const freshToken = (): string => mintToken(Date.now() + 120_000)
/** Inside the safety margin — the server would reject a reconnect with it. */
const staleToken = (): string => mintToken(Date.now() + JOIN_TOKEN_SAFETY_MS - 1_000)

type ProviderStatus = 'connected' | 'disconnected' | 'connecting'

interface FakeProvider extends CollabProviderLike {
  params: Record<string, string>
  shouldConnect: boolean
  /** y-websocket's cross-tab BroadcastChannel subscription flag (:443/:493). */
  bcconnected: boolean
  connectCalls: number
  disconnectCalls: number
  emit(event: ProviderEventName, status?: ProviderStatus): void
  listenerCount(event: ProviderEventName): number
}

/**
 * A y-websocket stand-in that models the two flags the refresh contract turns
 * on. `disconnect()` is deliberately faithful to y-websocket.js:499-505 — it
 * drops BOTH transports — so a regression back to calling it shows up as
 * `bcconnected === false`, which is exactly the cross-tab breakage the helper
 * exists to avoid. `connect()` only restores `shouldConnect` here: the real
 * `connectBc` re-subscribe is left out on purpose so a stray `disconnect()`
 * cannot be papered over by a following `connect()`.
 */
function makeProvider(token: string, overrides: Partial<CollabProviderLike> = {}): FakeProvider {
  const listeners = new Map<ProviderEventName, Set<(...a: never[]) => void>>()
  const provider: FakeProvider = {
    params: { jt: token },
    shouldConnect: true,
    bcconnected: true,
    connectCalls: 0,
    disconnectCalls: 0,
    connect() {
      provider.connectCalls++
      provider.shouldConnect = true
    },
    disconnect() {
      provider.disconnectCalls++
      provider.bcconnected = false
      provider.shouldConnect = false
    },
    on(event, cb) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(cb as (...a: never[]) => void)
    },
    off(event, cb) {
      listeners.get(event)?.delete(cb as (...a: never[]) => void)
    },
    emit(event, status = 'connected') {
      for (const cb of [...(listeners.get(event) ?? [])]) {
        if (event === 'status') {
          ;(cb as ProviderStateEvents['status'])({ status })
        } else {
          ;(cb as ProviderStateEvents['connection-close'])(null, provider)
        }
      }
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0
    },
    ...overrides,
  }
  return provider
}

/** Let the queueMicrotask hop plus the awaits inside the refresh settle. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
}

describe('readJoinTokenExp', () => {
  it('returns the exp (epoch ms) from a well-formed join token', () => {
    expect(readJoinTokenExp(mintToken(1_700_000_000_000))).toBe(1_700_000_000_000)
  })

  it('decodes base64url bodies containing - and _ substitutions', () => {
    // A body whose standard base64 needs BOTH substitutions, so the decoder's
    // character mapping is exercised rather than assumed. Real rids are
    // Crockford32 and never produce '+' or '/', which is precisely why this
    // case has to be constructed instead of sampled.
    const b64 = 'eyJyaWQiOiLfv9+/w6B+w6AiLCJleHAiOjE3MDAwMDAwMDAwMDAsInciOnRydWV9'
    expect(b64).toContain('+')
    expect(b64).toContain('/')
    const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_')
    expect(readJoinTokenExp(`${b64url}.c2ln`)).toBe(1_700_000_000_000)
  })

  it('returns null for malformed tokens instead of throwing', () => {
    expect(readJoinTokenExp('')).toBeNull()
    // Empty first segment — the `!body` guard, not the try/catch.
    expect(readJoinTokenExp('.sig')).toBeNull()
    expect(readJoinTokenExp('not-base64!!!.sig')).toBeNull()
    // Valid base64 that is not JSON at all.
    expect(readJoinTokenExp(`${btoa('hello')}.sig`)).toBeNull()
    // Valid JSON that is not an object — the `typeof json !== 'object'` guard.
    expect(readJoinTokenExp(`${btoa('42')}.sig`)).toBeNull()
    // Valid JSON `null` — typeof null is 'object', so the `!json` guard is what
    // catches this one.
    expect(readJoinTokenExp(`${btoa('null')}.sig`)).toBeNull()
    // An object (arrays included) with no / non-numeric / non-finite exp.
    expect(readJoinTokenExp(`${btoa('[1,2,3]')}.sig`)).toBeNull()
    expect(readJoinTokenExp(`${btoa('{"rid":"r"}')}.sig`)).toBeNull()
    expect(readJoinTokenExp(`${btoa('{"exp":"soon"}')}.sig`)).toBeNull()
    expect(readJoinTokenExp(`${btoa('{"exp":null}')}.sig`)).toBeNull()
  })
})

describe('wireJoinTokenRefresh', () => {
  it('does NOT refresh when the socket closes while the token is still valid', async () => {
    const provider = makeProvider(freshToken())
    const refresh = vi.fn(async () => freshToken())
    wireJoinTokenRefresh({
      provider,
      initialToken: provider.params.jt as string,
      refreshJoinToken: refresh,
    })

    provider.emit('connection-close')
    await settle()

    // An ordinary blip: y-websocket's own retry is left to succeed untouched.
    expect(refresh).not.toHaveBeenCalled()
    expect(provider.disconnectCalls).toBe(0)
    expect(provider.connectCalls).toBe(0)
  })

  it('re-provisions ONCE and reconnects with the fresh token when the socket closes stale', async () => {
    const stale = staleToken()
    const provider = makeProvider(stale)
    const fresh = freshToken()
    let release: ((t: string) => void) | undefined
    const refresh = vi.fn(
      () =>
        new Promise<string>(resolve => {
          release = resolve
        }),
    )
    wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh })

    provider.emit('connection-close')
    await settle()

    // CLEARING `shouldConnect` — not disconnect() — is what neuters y-websocket's
    // already-scheduled retry, so it never spends an attempt on the dead token
    // (the :175 setupWS guard). disconnect() would ALSO run disconnectBc(),
    // killing cross-tab sync that needs no server at all; it must never be
    // called here.
    expect(provider.shouldConnect).toBe(false)
    expect(provider.disconnectCalls).toBe(0)
    expect(provider.bcconnected).toBe(true)

    release?.(fresh)
    await settle()

    expect(refresh).toHaveBeenCalledTimes(1)
    expect(provider.params.jt).toBe(fresh)
    expect(provider.disconnectCalls).toBe(0)
    expect(provider.bcconnected).toBe(true)
    expect(provider.connectCalls).toBe(1)
    expect(provider.shouldConnect).toBe(true)
  })

  it('defers the refresh past the connection-close emit stack', () => {
    const stale = staleToken()
    const provider = makeProvider(stale)
    const refresh = vi.fn(async () => freshToken())
    wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh })

    provider.emit('connection-close')
    // Synchronously inside the emit, y-websocket has not yet nulled `ws`
    // (y-websocket.js:138) nor scheduled its retry (:160). Nothing of ours must
    // have run yet: no mint started, `shouldConnect` untouched, no disconnect().
    expect(refresh).not.toHaveBeenCalled()
    expect(provider.shouldConnect).toBe(true)
    expect(provider.disconnectCalls).toBe(0)
  })
  // THIS IS THE ONLY TEST IN THE WORKSPACE THAT DETECTS THE DEFERRAL, and it is
  // a synchronous double. Verified by deleting the `queueMicrotask` from
  // `refreshAndReconnect`'s caller: this test failed, and orbit-collab's
  // real-provider suite (both y-websocket majors), the kernel unit suite
  // (298 tests) and host-iframe (1576 tests) all stayed GREEN.
  //
  // The reason is structural, and it also bounds what the assertion above is
  // worth: nothing between y-websocket.js:137 and :168 reads `shouldConnect`,
  // and `refreshAndReconnect`'s first `await` (the mint) already defers
  // everything past the `shouldConnect` write to a microtask -- which cannot run
  // until `closeWebsocketConnection` has unwound past :168 in any case. So the
  // deferral is hygiene that makes the ordering argument true by construction
  // rather than by accident; it is NOT preventing a bug that would otherwise
  // reproduce. Keep both the deferral and this test -- but do not delete the
  // deferral on the strength of a green real-provider run, and do not claim
  // elsewhere that a real provider pins it.
  //
  // What a real provider DOES pin, on the wire, in
  // packages/orbit-collab/src/collab-auth-y-websocket.test.ts: that clearing
  // `shouldConnect` spares y-websocket an attempt on the dead token, and that
  // BroadcastChannel survives the refresh. Both fail-on-revert there.

  it('coalesces a burst of close events into a single re-provision', async () => {
    const stale = staleToken()
    const provider = makeProvider(stale)
    const refresh = vi.fn(async () => freshToken())
    wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh })

    provider.emit('connection-close')
    provider.emit('connection-close')
    provider.emit('connection-close')
    await settle()

    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reports give-up exactly once at the budget, without stopping the retry loop', async () => {
    vi.useFakeTimers()
    try {
      const stale = staleToken()
      const provider = makeProvider(stale)
      const refresh = vi.fn(async () => null)
      const onGiveUp = vi.fn()
      wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh, onGiveUp })

      provider.emit('connection-close')
      // Each failed mint schedules a backed-off retry; drain enough of them to
      // pass the budget.
      for (let i = 0; i < MAX_REFRESH_FAILURES + 2; i++) {
        await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS)
      }

      expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(MAX_REFRESH_FAILURES)
      expect(onGiveUp).toHaveBeenCalledTimes(1)
      expect(provider.connectCalls).toBe(0)

      // Give-up is a REPORT, not a terminal state. The old contract latched here
      // and only a page reload could revive the client; the loop must instead
      // keep retrying at the backoff ceiling forever, so that a mint outage of
      // any length still ends in a reconnect. Draining more ceilings must grow
      // the attempt count — while onGiveUp stays at one, so the UI is not
      // spammed for a single outage.
      const afterBudget = refresh.mock.calls.length
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS)
      }
      expect(refresh.mock.calls.length).toBeGreaterThan(afterBudget)
      expect(onGiveUp).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a throwing refresh the same as a null one', async () => {
    vi.useFakeTimers()
    try {
      const stale = staleToken()
      const provider = makeProvider(stale)
      const refresh = vi.fn(async () => {
        throw new Error('provision 503')
      })
      const onGiveUp = vi.fn()
      wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh, onGiveUp })

      provider.emit('connection-close')
      for (let i = 0; i < MAX_REFRESH_FAILURES + 2; i++) {
        await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS)
      }

      expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(MAX_REFRESH_FAILURES)
      expect(onGiveUp).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds — but does not stop — a mint that only ever returns stale tokens', async () => {
    vi.useFakeTimers()
    try {
      // Every "fresh" token is already stale (the shape a client clock running
      // ahead of the server produces). A token we cannot use is a MINT failure,
      // so this lands on the backoff path; budgeting it as a success would spin
      // the re-provision at network speed for the whole outage.
      const stale = staleToken()
      const provider = makeProvider(stale)
      const refresh = vi.fn(async () => staleToken())
      const onGiveUp = vi.fn()
      wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh, onGiveUp })

      provider.emit('connection-close')
      const span = RECONNECT_MAX_BACKOFF_MS * 10
      await vi.advanceTimersByTimeAsync(span)

      // Rate-bounded, not spinning: even the fastest possible chain (every
      // backoff at the low end of the jitter band, after the exponential ramp)
      // cannot fit more than a couple of dozen attempts into this span.
      expect(refresh.mock.calls.length).toBeLessThan(30)
      expect(onGiveUp).toHaveBeenCalledTimes(1)
      expect(provider.connectCalls).toBe(0)

      // ...and the loop is still alive afterwards. The old contract latched
      // terminal here, so a clock that later corrected itself could never
      // reconnect without a reload.
      const after = refresh.mock.calls.length
      await vi.advanceTimersByTimeAsync(span)
      expect(refresh.mock.calls.length).toBeGreaterThan(after)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the budget on a usable mint and re-arms give-up on a connected status', async () => {
    vi.useFakeTimers()
    try {
      const stale = staleToken()
      const provider = makeProvider(stale)
      const refresh = vi.fn(async (): Promise<string | null> => null)
      const onGiveUp = vi.fn()
      wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh, onGiveUp })

      provider.emit('connection-close')
      for (let i = 0; i < MAX_REFRESH_FAILURES + 2; i++) {
        await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS)
      }
      expect(onGiveUp).toHaveBeenCalledTimes(1)

      // The mint recovers. A USABLE token alone reconnects and zeroes the
      // counter — no 'connected' status required, because the collab server may
      // still be down and we must not need its cooperation to keep trying.
      let good = ''
      refresh.mockImplementation(async () => {
        good = freshToken()
        return good
      })
      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS * 2)
      expect(provider.params.jt).toBe(good)
      expect(provider.connectCalls).toBeGreaterThanOrEqual(1)
      // Still only one report: the outage has not ended as far as the UI knows.
      expect(onGiveUp).toHaveBeenCalledTimes(1)

      // The socket actually opens → the next outage is a NEW outage and must be
      // reported again, rather than being silently swallowed forever.
      provider.emit('status', 'connected')
      refresh.mockImplementation(async () => null)
      const before = refresh.mock.calls.length
      // Let the good token age out so the next close reads as stale.
      await vi.advanceTimersByTimeAsync(120_000)
      provider.emit('connection-close')
      for (let i = 0; i < MAX_REFRESH_FAILURES + 2; i++) {
        await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS)
      }
      // A full fresh budget was spent, which only holds if the usable mint had
      // zeroed the counter.
      expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(before + MAX_REFRESH_FAILURES)
      expect(onGiveUp).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers from a collab-server outage of ANY length, never reporting give-up', async () => {
    vi.useFakeTimers()
    try {
      // THE HEADLINE INVARIANT. Token minting is healthy throughout — every
      // refresh returns a genuinely fresh token — but the collab server is down,
      // so no 'connected' status ever arrives. The old contract spent give-up
      // budget on each of these cycles, so ~9 minutes of server downtime latched
      // the client terminal and only a page reload brought it back. Nothing here
      // may consume budget: usable tokens are positive evidence that AUTH is
      // fine, and the outage is rate-limited by the token TTL instead.
      const stale = staleToken()
      const provider = makeProvider(stale)
      const refresh = vi.fn(async () => freshToken())
      const onGiveUp = vi.fn()
      wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh, onGiveUp })

      /** One outage cycle: the fresh token ages out, the socket closes stale. */
      const staleCloseCycle = async (): Promise<void> => {
        await vi.advanceTimersByTimeAsync(115_000)
        provider.emit('connection-close')
        await settle()
      }

      const CYCLES = 12 // well past twice MAX_REFRESH_FAILURES
      provider.emit('connection-close')
      await settle()
      for (let i = 1; i < CYCLES; i++) await staleCloseCycle()

      expect(refresh).toHaveBeenCalledTimes(CYCLES)
      expect(provider.connectCalls).toBe(CYCLES)
      expect(onGiveUp).not.toHaveBeenCalled()
      expect(provider.disconnectCalls).toBe(0)
      expect(provider.bcconnected).toBe(true)

      // The server comes back. A later stale close must still refresh and
      // reconnect — the wiring survived the whole outage intact.
      provider.emit('status', 'connected')
      await staleCloseCycle()
      expect(refresh).toHaveBeenCalledTimes(CYCLES + 1)
      expect(provider.connectCalls).toBe(CYCLES + 1)
      expect(onGiveUp).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps cross-tab BroadcastChannel alive across a full give-up', async () => {
    vi.useFakeTimers()
    try {
      // Cross-tab sync needs no server at all, so tearing it down because the
      // SERVER (or the mint) is unreachable is strictly wrong: other tabs would
      // see this one vanish and stop receiving its edits. The old code called
      // provider.disconnect() on every attempt, which runs disconnectBc().
      const stale = staleToken()
      const provider = makeProvider(stale)
      const refresh = vi.fn(async () => null)
      const onGiveUp = vi.fn()
      wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh, onGiveUp })

      provider.emit('connection-close')
      for (let i = 0; i < MAX_REFRESH_FAILURES + 5; i++) {
        await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS)
        expect(provider.bcconnected).toBe(true)
        expect(provider.disconnectCalls).toBe(0)
      }

      expect(onGiveUp).toHaveBeenCalledTimes(1)
      expect(provider.bcconnected).toBe(true)
      expect(provider.disconnectCalls).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects after give-up once minting recovers, with no re-wiring', async () => {
    vi.useFakeTimers()
    try {
      // The path back from a reported give-up. Without it, a long api-worker
      // outage leaves the client dead for the rest of the session.
      const stale = staleToken()
      const provider = makeProvider(stale)
      const onGiveUp = vi.fn()
      let good = ''
      const refresh = vi.fn(async () => {
        if (onGiveUp.mock.calls.length === 0) return null
        good = freshToken()
        return good
      })
      wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh, onGiveUp })

      provider.emit('connection-close')
      for (let i = 0; i < MAX_REFRESH_FAILURES + 4; i++) {
        await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS)
      }

      expect(onGiveUp).toHaveBeenCalledTimes(1)
      expect(provider.params.jt).toBe(good)
      expect(provider.connectCalls).toBe(1)
      expect(provider.shouldConnect).toBe(true)
      // No teardown of either transport along the way.
      expect(provider.disconnectCalls).toBe(0)
      expect(provider.bcconnected).toBe(true)
      // And the wiring is untouched, so the NEXT outage is handled too.
      expect(provider.listenerCount('connection-close')).toBe(1)
      expect(provider.listenerCount('status')).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('recovers when a mint HANGS instead of failing, rather than stalling forever', async () => {
    // A mint that never settles is the one way the loop could stop on its own:
    // `refreshAndReconnect` clears `shouldConnect` BEFORE awaiting, so while the
    // mint hangs y-websocket's own retry is disabled too and nothing is left to
    // wake the client. A black-holed fetch after a laptop wake (captive portal,
    // dead TCP connection) does exactly this. The contract claims to be
    // non-terminal, so the hang must be bounded and land on the retry path.
    vi.useFakeTimers()
    try {
      const stale = staleToken()
      const provider = makeProvider(stale)
      let calls = 0
      const refresh = vi.fn(() => {
        calls++
        // First attempt hangs forever; a later attempt succeeds.
        if (calls === 1) return new Promise<string | null>(() => {})
        return Promise.resolve(freshToken())
      })
      wireJoinTokenRefresh({ provider, initialToken: stale, refreshJoinToken: refresh })

      provider.emit('connection-close')
      await vi.advanceTimersByTimeAsync(0)
      expect(refresh).toHaveBeenCalledTimes(1)
      // y-websocket's own retry is off while the mint is in flight.
      expect(provider.shouldConnect).toBe(false)

      // The hang must time out and be retried, not stall the client forever.
      await vi.advanceTimersByTimeAsync(MINT_TIMEOUT_MS + RECONNECT_MAX_BACKOFF_MS * 2)
      expect(refresh.mock.calls.length).toBeGreaterThan(1)
      expect(provider.params.jt).not.toBe(stale)
      expect(provider.connectCalls).toBe(1)
      expect(provider.shouldConnect).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('teardown unsubscribes, cancels a pending retry, and stops an in-flight refresh', async () => {
    vi.useFakeTimers()
    try {
      const stale = staleToken()
      const provider = makeProvider(stale)
      const refresh = vi.fn(async () => null)
      const stop = wireJoinTokenRefresh({
        provider,
        initialToken: stale,
        refreshJoinToken: refresh,
      })
      expect(provider.listenerCount('connection-close')).toBe(1)

      provider.emit('connection-close')
      await vi.advanceTimersByTimeAsync(0)
      expect(refresh).toHaveBeenCalledTimes(1)

      stop()
      expect(provider.listenerCount('connection-close')).toBe(0)
      expect(provider.listenerCount('status')).toBe(0)

      await vi.advanceTimersByTimeAsync(RECONNECT_MAX_BACKOFF_MS * 3)
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(provider.connectCalls).toBe(0)

      // A close after teardown (as provider.destroy() emits) is inert.
      provider.emit('connection-close')
      await settle()
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never reconnects when teardown races an in-flight refresh', async () => {
    const stale = staleToken()
    const provider = makeProvider(stale)
    let release: ((t: string) => void) | undefined
    const stop = wireJoinTokenRefresh({
      provider,
      initialToken: stale,
      refreshJoinToken: () =>
        new Promise<string>(resolve => {
          release = resolve
        }),
    })

    provider.emit('connection-close')
    await settle()
    stop()
    release?.(freshToken())
    await settle()

    expect(provider.connectCalls).toBe(0)
  })

  it('is a no-op for an unparseable token (no basis to judge staleness)', () => {
    const provider = makeProvider('garbage')
    const refresh = vi.fn(async () => freshToken())
    const stop = wireJoinTokenRefresh({
      provider,
      initialToken: 'garbage',
      refreshJoinToken: refresh,
    })

    expect(provider.listenerCount('connection-close')).toBe(0)
    provider.emit('connection-close')
    expect(refresh).not.toHaveBeenCalled()
    expect(() => stop()).not.toThrow()
  })

  it('is a no-op for a provider with no event surface', () => {
    const token = staleToken()
    const bare: CollabProviderLike = { params: { jt: token } }
    const refresh = vi.fn(async () => freshToken())
    const stop = wireJoinTokenRefresh({
      provider: bare,
      initialToken: token,
      refreshJoinToken: refresh,
    })
    expect(refresh).not.toHaveBeenCalled()
    expect(() => stop()).not.toThrow()
  })
})

describe('reconnectMaxBackoffMs', () => {
  const MIN = RECONNECT_MAX_BACKOFF_MS * (1 - RECONNECT_BACKOFF_JITTER)
  const MAX = RECONNECT_MAX_BACKOFF_MS * (1 + RECONNECT_BACKOFF_JITTER)

  it('draws inside the jitter band at both extremes of the RNG', () => {
    // Pinned rather than sampled: the band's EDGES are what bound the worst
    // case, and a chance draw never visits them.
    const random = vi.spyOn(Math, 'random')
    try {
      random.mockReturnValue(0)
      expect(reconnectMaxBackoffMs()).toBe(MIN)
      random.mockReturnValue(0.5)
      expect(reconnectMaxBackoffMs()).toBe(RECONNECT_MAX_BACKOFF_MS)
      random.mockReturnValue(1)
      expect(reconnectMaxBackoffMs()).toBe(MAX)
    } finally {
      random.mockRestore()
    }
  })

  it('spreads the fleet instead of retrying in lockstep', () => {
    // y-websocket's own backoff has no randomness (:160-167), so a shared
    // constant ceiling makes every client in the room retry on the same tick —
    // a thundering herd landing on a collab server that is still coming back up.
    const draws = Array.from({ length: 200 }, () => reconnectMaxBackoffMs())
    for (const d of draws) {
      expect(d).toBeGreaterThanOrEqual(MIN)
      expect(d).toBeLessThanOrEqual(MAX)
    }
    expect(new Set(draws).size).toBeGreaterThan(1)
    // Well above y-websocket's 2.5 s default, which is what made one room
    // produce ~24 failed connects a minute for a whole outage.
    expect(MIN).toBeGreaterThan(2_500)
  })
})
