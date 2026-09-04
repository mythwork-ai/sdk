// The collab join-token reconnect contract, shared by every y-websocket client
// in the workspace.
//
// WHY THIS EXISTS. A collab join token lives 120 s
// (`JOIN_TTL_MS`, workers/api/src/common/room-id.ts:53) and the Rust collab
// server verifies it ONLY at the WebSocket upgrade (`ws_handler`,
// collab/src/main.rs:413 — `verify_room_id` at :441, `verify_join_token` at
// :454, each refusing with a 401) — an already-open connection never expires,
// but every RECONNECT is re-authorized. (Do NOT read `is_authorized_room`
// at :333 for this: it gates only the `/rooms` and `/rooms/top` introspection
// endpoints, at :348 and :381, and reuses the same two checks — it is not in
// the WebSocket path.) y-websocket re-encodes `params` into the socket
// URL on every reconnect (y-websocket.js:403-407 `get url()`, called from
// `setupWS` at :176) and retries forever while `shouldConnect` is true, backing
// off to only 2.5 s (:277).
//
// So a client that hands its token to the provider once, at construction, and
// never updates it turns any disconnect longer than two minutes — laptop lid,
// wifi drop, a backgrounded tab — into a guaranteed rejection on EVERY
// subsequent reconnect, retried indefinitely — the room stays unjoinable for
// as long as that client lives: no peer sync, no presence, no propagation of
// the active commit to collaborators.
// (Local commits were NOT lost to this: `commitAndUpload` does the local commit
// before any network work — packages/orbit-kernel/src/git/sync.ts:232-235.)
//
// THE FIX. On 'connection-close', if the current token is at/near expiry, stop
// y-websocket's own retry, mint a fresh token, write it into `params.jt`, and
// reconnect. A close with a STILL-VALID token is left entirely alone: that is an
// ordinary network blip and y-websocket's own reconnect will succeed with the
// token it already has.
//
// The contract is NON-TERMINAL: until torn down, it keeps trying. Only a failure
// to MINT is budgeted, and even that budget reports rather than stops. See
// {@link wireJoinTokenRefresh} for why, and what breaks if you budget connect
// failures instead.
//
// There is deliberately NO proactive refresh while connected: the server checks
// the token at connect only, so a live socket needs nothing.
//
// WHICH y-websocket THESE LINE NUMBERS DESCRIBE. The workspace resolves two
// majors: `packages/orbit-collab` and `sdk/client` get 2.1.0; `orbit-kernel`,
// `host-iframe`, `mythcode-bridge` and the root get 3.0.0. Every line number
// cited in this file is valid for BOTH. Their ESM entry — `src/y-websocket.js`,
// which is what all six sites import (`exports['.'].import`) — differs between
// the two versions by exactly one line, and that line is a COMMENT at :281:
//
//   -    // ensure that url is always ends with /
//   +    // ensure that serverUrl does not end with /
//
// Nothing else differs, so no line shifts and the emit ordering, the :175
// `shouldConnect` guard, `disconnectBc`, and the 2_500 `maxBackoffTime` default
// are identical. The 3.0.0 major bump dropped the bundled server (`bin/`) and
// re-pointed the CJS build's lib0 subpath imports; the client provider was not
// touched. Verified by diffing the two installed copies, not inferred from the
// API surface. `packages/orbit-collab/src/collab-auth-y-websocket.test.ts` pins
// this against a REAL 2.1.0 provider so a future bump that DOES change the
// ordering fails a test instead of silently breaking the two v2 sites.
//
// This module has no dependency on y-websocket, yjs, or any DOM API beyond
// `atob`/`setTimeout` — the provider is consumed through the structural
// {@link CollabProviderLike} interface, which y-websocket's `WebsocketProvider`
// satisfies as-is and a test double can satisfy in a dozen lines.

/**
 * How close to `exp` a token is treated as already dead.
 *
 * Both a re-provision round trip (`POST /room/provision`, or whatever the
 * caller's `refreshJoinToken` does) and the following WebSocket handshake must
 * land before the server's connect-time `exp` check, so a token expiring within
 * this window is not worth reconnecting with.
 *
 * 10 s is chosen to sit BELOW the host bridge's own 30 s pre-expiry cache
 * eviction (packages/host-iframe/src/bridges/collab.ts `EXP_SAFETY_MARGIN_MS`).
 * That ordering is what makes the refresh useful: by the time we call a token
 * stale, the cache entry has already been evicted, so the re-provision is a
 * guaranteed cache MISS that mints a genuinely new token instead of handing
 * back the same dying one.
 */
export const JOIN_TOKEN_SAFETY_MS = 10_000

/**
 * Base ceiling on y-websocket's exponential reconnect backoff (its own default
 * is 2_500 — y-websocket.js:277). Callers pass {@link reconnectMaxBackoffMs},
 * not this constant, so that the fleet does not retry in lockstep.
 *
 * At 2.5 s a single room hammers a down server ~24 times a minute. 30 s caps
 * one room at ~2 attempts a minute while costing nothing for ordinary blips:
 * the backoff still STARTS at 100 ms and climbs exponentially, so the first
 * several retries are as fast as before and only a sustained outage reaches
 * the ceiling.
 */
export const RECONNECT_MAX_BACKOFF_MS = 30_000

/**
 * Fraction of {@link RECONNECT_MAX_BACKOFF_MS} the per-client ceiling is spread
 * over, +/-. 0.25 turns a 30 s ceiling into a uniform draw from [22.5 s, 37.5 s].
 */
export const RECONNECT_BACKOFF_JITTER = 0.25

/**
 * A per-client reconnect-backoff ceiling, jittered around
 * {@link RECONNECT_MAX_BACKOFF_MS}.
 *
 * WHY JITTER. y-websocket's backoff is `min(2^n * 100, maxBackoffTime)` with no
 * randomness of its own (the `setTimeout(setupWS, …)` at y-websocket.js:160-167,
 * whose delay is `math.min(math.pow(2, n) * 100, maxBackoffTime)` at :162-165).
 * Every client in the fleet
 * disconnects at the same instant when the collab server restarts, so a shared
 * constant ceiling makes the whole fleet retry in lockstep — a thundering herd
 * landing on a server in the middle of coming back up, which is precisely when
 * it is least able to absorb it. Drawing the ceiling once per provider spreads
 * those retries over a 15 s window instead of stacking them on one tick.
 *
 * Called once per provider construction; the value is stable for that
 * provider's life, so a client's retry cadence stays predictable.
 */
export function reconnectMaxBackoffMs(): number {
  const spread = RECONNECT_MAX_BACKOFF_MS * RECONNECT_BACKOFF_JITTER
  return Math.round(RECONNECT_MAX_BACKOFF_MS - spread + Math.random() * 2 * spread)
}

/**
 * How many consecutive refresh attempts may fail to produce a USABLE join token
 * before the client reports the failure through `onGiveUp`. Five rides out a
 * transient api-worker blip while making a genuinely broken auth path visible
 * instead of leaving the UI on a spinner that will never resolve.
 *
 * "Usable token" is the load-bearing part, and it is deliberately NOT "live
 * connection" — see {@link wireJoinTokenRefresh} for why budgeting connect
 * failures is the wrong shape. Reporting is also not terminating: the refresh
 * loop keeps running past this threshold at the backoff ceiling, so a client
 * that has reported give-up still recovers on its own once minting works again.
 */
export const MAX_REFRESH_FAILURES = 5

/**
 * How long a single `refreshJoinToken()` call may run before it is abandoned and
 * counted as a mint failure.
 *
 * WHY A TIMEOUT IS LOAD-BEARING, not defensive. `refreshAndReconnect` clears
 * `provider.shouldConnect` BEFORE awaiting the mint, so while a mint is in
 * flight y-websocket's own retry loop is deliberately disabled. If the mint
 * promise never settles, nothing is left to wake the client: no socket attempt,
 * no retry timer, and not even `onGiveUp` — the UI sits on 'connecting'
 * forever and only a page reload recovers it. That is precisely the terminal
 * state this module's contract promises cannot exist, so the hang has to be
 * bounded here rather than trusted to the caller.
 *
 * A hang is not hypothetical for the four BROWSER-side refreshers: each is
 * either a `fetch` (`provisionRoom`) or a postMessage RPC to the host frame,
 * and neither settles on a black-holed TCP connection — the ordinary state of a
 * laptop resumed behind a captive portal, which is also exactly when the join
 * token is guaranteed to be stale.
 *
 * The other two of the six wiring sites cannot hang at all: the mythcode-bridge
 * CLI mints locally, with no network in the path
 * (`joinTokenRefresher`, packages/mythcode-bridge/src/cli.ts:42-49, whose body
 * is `mintJoinToken` — packages/mythcode-bridge/src/minting.ts:55, a
 * SYNCHRONOUS `node:crypto` `createHmac` merely wrapped in an `async` arrow),
 * feeding run-bridge.ts:117 via cli.ts:86 and the `watch` wiring at cli.ts:112.
 * So this timeout guards the four that can hang and is a harmless no-op for the
 * two that cannot — which is why it stays unconditional rather than becoming a
 * per-caller option.
 *
 * 15 s is comfortably above a real re-provision round trip and well under the
 * 120 s token TTL, so a timed-out attempt still leaves time for the retry that
 * follows it to produce a usable token.
 */
export const MINT_TIMEOUT_MS = 15_000

/**
 * Read the `exp` (epoch ms) out of a collab join token, or null if it cannot be
 * read. The token is `b64url(body).b64url(sig)` with body JSON `{ rid, exp, w }`
 * (workers/api/src/common/room-id.ts); this decodes the FIRST segment exactly
 * the way the api worker does when it echoes `exp` back to the client
 * (workers/api/src/routes/projects/provision-room.ts). It is read from the token
 * because {@link RoomDescriptor} carries no `exp` field.
 *
 * The signature is deliberately NOT verified — the client holds no key and has
 * no authority here. `exp` is used purely as a local hint for "will the server
 * still accept this token if I reconnect now?"; the collab server remains the
 * only thing that actually validates the token.
 */
export function readJoinTokenExp(joinToken: string): number | null {
  try {
    const body = joinToken.split('.')[0]
    if (!body) return null
    const json: unknown = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')))
    if (!json || typeof json !== 'object') return null
    const exp = (json as { exp?: unknown }).exp
    return typeof exp === 'number' && Number.isFinite(exp) ? exp : null
  } catch {
    return null
  }
}

/**
 * Connectivity/sync events y-websocket's `WebsocketProvider` emits. The key set
 * mirrors its own ObservableV2 event map exactly (y-websocket.js:253) — a
 * generic `on<K extends keyof ...>` signature only stays assignable from the
 * real provider's equally-generic one if the maps have the same keys, so
 * 'connection-error' is listed here even though nothing subscribes to it.
 */
export type ProviderStateEvents = {
  status: (e: { status: 'connected' | 'disconnected' | 'connecting' }) => void
  sync: (synced: boolean) => void
  /** Emitted at y-websocket.js:137, synchronously, as a socket closes. */
  'connection-close': (event: unknown, provider: unknown) => void
  'connection-error': (event: unknown, provider: unknown) => void
}

/** The event names {@link CollabProviderLike.on}/`off` accept. */
export type ProviderEventName = keyof ProviderStateEvents

/**
 * The provider surface this module consumes, structurally satisfied by
 * y-websocket's `WebsocketProvider`. Members are optional so minimal test fakes
 * stay usable — and their absence is handled rather than assumed: a provider
 * with no `on` can never be wired at all (see {@link wireJoinTokenRefresh}).
 */
export interface CollabProviderLike {
  /**
   * Re-opens the socket, re-reading `params` for the URL (y-websocket.js:507).
   * Also re-subscribes BroadcastChannel, idempotently (`connectBc` is guarded by
   * `!this.bcconnected`, :443), so calling it while cross-tab sync is already up
   * is harmless.
   */
  connect?(): void
  /**
   * Full teardown of BOTH transports. This module never calls it — see
   * `stopWebsocketRetry` in {@link wireJoinTokenRefresh} — but consumers of this
   * interface do, so it stays part of the surface.
   */
  disconnect?(): void
  /**
   * y-websocket's own "should I keep retrying the socket?" flag (:318, guarding
   * `setupWS` at :175). Writable by design here: it is the ONLY lever that stops
   * the websocket retry loop without also tearing down BroadcastChannel.
   */
  shouldConnect?: boolean
  /**
   * The query params y-websocket appends to the socket URL. Mutable by design —
   * y-websocket re-encodes it on every reconnect (`get url()`, :403-407), which
   * is what lets us swap in a freshly minted join token. Typed as y-websocket
   * types it (`Object<string,string>`) so the real provider stays assignable.
   */
  params?: Record<string, string>
  on?<K extends ProviderEventName>(event: K, cb: ProviderStateEvents[K]): void
  off?<K extends ProviderEventName>(event: K, cb: ProviderStateEvents[K]): void
}

export interface JoinTokenRefreshOptions {
  /** The live provider whose `params.jt` is kept usable. */
  provider: CollabProviderLike
  /** The token the provider was constructed with. */
  initialToken: string
  /**
   * Mint a FRESH join token for the same room, or resolve null when no server
   * room is available any more (local-only project, provisioning failure,
   * signed out). Called only on a reconnect whose current token is at/near
   * expiry. A rejection is treated exactly like a null.
   */
  refreshJoinToken: () => Promise<string | null>
  /**
   * Called once per outage, when {@link MAX_REFRESH_FAILURES} consecutive
   * attempts have failed to MINT a usable token. Callers that surface connection
   * state should report it as disconnected here.
   *
   * This is a REPORT, not a terminal state: the refresh loop keeps retrying at
   * the backoff ceiling afterwards, and a later success reconnects the client
   * and re-arms this callback for the next outage. Callers must therefore not
   * latch on it permanently — clear whatever they set here when the provider
   * next reports 'connected'. Omit and the give-up is silent.
   */
  onGiveUp?: () => void
}

/**
 * Exponential backoff for the refresh retry chain, jittered and capped, so a
 * fleet of clients whose mints all started failing at the same instant does not
 * retry on the same tick.
 */
function backoffMs(attempt: number): number {
  const capped = Math.min(2 ** attempt * 1_000, RECONNECT_MAX_BACKOFF_MS)
  const spread = capped * RECONNECT_BACKOFF_JITTER
  return Math.round(capped - spread + Math.random() * 2 * spread)
}

/**
 * Keep a provider's join token usable across reconnects, and return a teardown.
 *
 * The teardown MUST be called before `provider.destroy()`: destroying closes the
 * socket, which emits 'connection-close', and a handler still attached would
 * schedule a refresh for a provider that must never reconnect.
 *
 * Wiring is skipped entirely (a no-op teardown is returned) when the provider
 * exposes no `on` — there is nothing to observe — or when `initialToken` has no
 * readable `exp`, since that leaves no basis on which to judge staleness and the
 * honest fallback is y-websocket's pre-existing behavior.
 *
 * THE CONTRACT IS NON-TERMINAL. Until the teardown is called, this keeps trying
 * — there is no state it can reach from which it stops on its own. That is the
 * property that makes it safe to put in front of y-websocket, which also retries
 * forever: an outage of any length, of either the collab server or the token
 * mint, ends in a connected client once the outage ends, with no user action and
 * no page reload. `onGiveUp` reports a long mint failure so the UI can stop
 * lying; it does not stop the loop.
 */
export function wireJoinTokenRefresh(opts: JoinTokenRefreshOptions): () => void {
  const { provider, initialToken, refreshJoinToken, onGiveUp } = opts
  const on = provider.on?.bind(provider)
  const off = provider.off?.bind(provider)
  let tokenExp = readJoinTokenExp(initialToken)
  if (!on || !off || tokenExp === null) return () => {}

  let stopped = false
  /** True once `onGiveUp` has fired for the CURRENT outage; re-armed on connect. */
  let reportedGiveUp = false
  /** True from the moment a refresh is scheduled until it settles. */
  let refreshing = false
  /**
   * Consecutive refresh cycles that produced no USABLE token. Reset by any
   * usable mint, and by a real 'connected' status.
   */
  let mintFailures = 0
  /** Pending retry of a failed refresh; cleared by the teardown. */
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Resolver of the mint currently in flight, so both the {@link MINT_TIMEOUT_MS}
   * timer and the teardown can release the frame awaiting it. Null when no mint
   * is in flight.
   */
  let settleMint: ((token: string | null) => void) | null = null

  /** Is a token too close to `exp` for a reconnect to be accepted? */
  const isStale = (exp: number | null): boolean =>
    exp !== null && Date.now() >= exp - JOIN_TOKEN_SAFETY_MS

  /**
   * Stop y-websocket's own retry loop WITHOUT tearing down BroadcastChannel.
   *
   * `provider.disconnect()` would be the obvious call, but it runs
   * `disconnectBc()` first (:501, before it even touches the socket at :502-504):
   * that broadcasts an awareness-removal to every other tab and then
   * unsubscribes the channel (:484-496). Cross-tab
   * collaboration needs no server at all, so killing it because the SERVER is
   * unreachable is strictly wrong — other tabs would see this one vanish and
   * stop receiving its edits on every refresh cycle, for the whole outage.
   *
   * Clearing `shouldConnect` achieves the one thing we actually want: the
   * pending `setTimeout(setupWS, ...)` queued at :160 becomes a no-op at its
   * :175 guard, so y-websocket does not spend an attempt on the dead token.
   * There is no socket left to close either — `closeWebsocketConnection` already
   * nulled `provider.ws` at :138, synchronously, before this ever runs (see
   * `refreshAndReconnect` on the emit ordering). `provider.connect()` sets the
   * flag back and re-subscribes BC idempotently.
   */
  const stopWebsocketRetry = (): void => {
    provider.shouldConnect = false
  }

  /**
   * Run `refreshJoinToken()` under {@link MINT_TIMEOUT_MS}, resolving null on a
   * timeout, a rejection, or a synchronous throw. Never rejects, so the caller
   * has exactly one failure shape to handle.
   *
   * A mint that resolves AFTER its timeout is discarded rather than applied:
   * `finish` is idempotent, so the abandoned attempt cannot write a token into a
   * provider that the retry chain has since moved past, and cannot start a
   * second concurrent chain.
   */
  const mintWithTimeout = (): Promise<string | null> =>
    new Promise<string | null>(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (token: string | null): void => {
        if (settleMint !== finish) return
        settleMint = null
        if (timer !== null) clearTimeout(timer)
        resolve(token)
      }
      settleMint = finish
      timer = setTimeout(() => finish(null), MINT_TIMEOUT_MS)
      try {
        refreshJoinToken().then(
          token => finish(token ?? null),
          () => finish(null),
        )
      } catch {
        finish(null)
      }
    })

  /**
   * Re-mint the token and reconnect — read with y-websocket.js:135-169 open,
   * `closeWebsocketConnection`:
   *
   *   :137 emit('connection-close')  <- our handler ran here, synchronously
   *   :138 provider.ws = null
   *   :160 setTimeout(setupWS, min(2^n * 100, maxBackoffTime))
   *   :175 setupWS: `if (provider.shouldConnect && provider.ws === null)`
   *
   * By the time this runs, `ws` is already null and y-websocket's own retry is
   * merely PENDING (>= 100 ms out). Clearing `shouldConnect` makes that pending
   * `setupWS` a no-op at its :175 guard — y-websocket does not get to spend one
   * attempt on the dead token. That is the load-bearing part, and it is pinned
   * on the wire against both installed majors by
   * `packages/orbit-collab/src/collab-auth-y-websocket.test.ts`: removing the
   * `shouldConnect = false` makes the stale token appear on a second dial and
   * fails that test.
   *
   * Doing this instead of `disconnect()` also avoids `disconnectBc()` — see
   * `stopWebsocketRetry` — and the re-entry into `closeWebsocketConnection`
   * (:503) with the spurious `wsUnsuccessfulReconnects++` from the :156
   * else-branch.
   *
   * ON THE `queueMicrotask` IN `onConnectionClose`, honestly. It defers this
   * function off the :137 emit stack, and that is hygiene rather than a
   * correctness requirement: nothing between :137 and :168 reads
   * `shouldConnect`, and this function's first `await` (the mint) already defers
   * everything past the `shouldConnect` write to a microtask — which cannot run
   * until `closeWebsocketConnection` has unwound past :168 in any case. Removing
   * the deferral was tried: both real-provider majors, host-iframe, and the
   * kernel browser suite all stayed green, and only the synchronous double at
   * `sdk/protocol/src/collab-auth.test.ts:196` caught it. Keep it — it is what
   * makes the ordering argument above true by construction rather than by
   * accident — but do not believe a green real-provider run is evidence for it.
   *
   * WHY ONLY MINT FAILURES ARE BUDGETED. There are two different failures behind
   * "still not connected", and conflating them is what makes a client
   * unrecoverable:
   *
   *   - We cannot GET a token (api worker down, signed out, provisioning
   *     rejected). Retrying is nearly free but never succeeds on its own, and
   *     the user should be told. That is what {@link MAX_REFRESH_FAILURES}
   *     bounds, and what `onGiveUp` reports.
   *   - We HAVE a good token but cannot USE it, because the collab server is
   *     down. A freshly minted token is positive evidence that auth is healthy;
   *     spending give-up budget on it means a long-enough server outage kills a
   *     client that would otherwise have recovered the moment the server came
   *     back — strictly worse than the plain y-websocket behavior this contract
   *     replaces.
   *
   * So a usable mint resets the budget and reconnects, and the outage is then
   * rate-limited by two things that need no budget at all: y-websocket's own
   * capped, jittered backoff between socket attempts, and the ~110 s token TTL
   * between refresh cycles. A server outage of any length therefore ends in a
   * connected client, with no user action, as soon as the server returns.
   *
   * The one case that could spin is a mint that keeps returning an ALREADY-stale
   * token (a client clock far enough ahead that nothing ever looks fresh). That
   * is a token we cannot use, so it counts as a mint failure and lands on the
   * backoff path rather than looping.
   */
  const refreshAndReconnect = async (): Promise<void> => {
    stopWebsocketRetry()
    // Bounded: an unbounded mint would strand the client with y-websocket's own
    // retry already disabled. See MINT_TIMEOUT_MS.
    const fresh: string | null = await mintWithTimeout()
    // The teardown may have raced the refresh — a torn-down client must never
    // reconnect.
    if (stopped) return
    const freshExp = fresh === null ? null : readJoinTokenExp(fresh)
    // An unreadable `exp` is accepted: it leaves no basis to judge staleness, so
    // the honest fallback is to use the token and stop judging (`tokenExp` goes
    // null, `isStale` goes permanently false, y-websocket's own behavior takes
    // over from here).
    if (fresh === null || isStale(freshExp)) {
      mintFailures++
      if (mintFailures >= MAX_REFRESH_FAILURES && !reportedGiveUp) {
        reportedGiveUp = true
        onGiveUp?.()
      }
      // A re-provision can fail transiently (a blip, a mid-flight session
      // refresh). Retry with exponential backoff under the same jittered
      // ceiling, indefinitely: there is no state this can reach from which a
      // later success would not be the right answer.
      retryTimer = setTimeout(() => {
        retryTimer = null
        if (stopped) return
        void refreshAndReconnect()
      }, backoffMs(mintFailures))
      return
    }
    mintFailures = 0
    tokenExp = freshExp
    // y-websocket re-encodes params into the URL on the next setupWS, so this
    // assignment IS how the new token reaches the server.
    if (provider.params) provider.params.jt = fresh
    refreshing = false
    provider.connect?.()
  }

  const onConnectionClose = (): void => {
    if (stopped || refreshing || retryTimer !== null) return
    // Token still comfortably valid → an ordinary network blip, or a server
    // outage we already hold a good token for. Do nothing; y-websocket's own
    // reconnect will retry with the token it already has.
    if (!isStale(tokenExp)) return
    refreshing = true
    // Deferred ON PURPOSE — see refreshAndReconnect's note on the emit ordering.
    queueMicrotask(() => {
      if (stopped) return
      void refreshAndReconnect()
    })
  }

  /**
   * A socket that actually opened clears the outage: the mint budget is refunded
   * and `onGiveUp` is re-armed so a future outage reports again.
   */
  const onStatus = (e: { status: 'connected' | 'disconnected' | 'connecting' }): void => {
    if (e.status !== 'connected') return
    mintFailures = 0
    reportedGiveUp = false
  }

  on('connection-close', onConnectionClose)
  on('status', onStatus)

  return () => {
    if (stopped) return
    stopped = true
    off('connection-close', onConnectionClose)
    off('status', onStatus)
    if (retryTimer !== null) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
    // Release the frame awaiting an in-flight mint (and clear its timeout timer)
    // so teardown leaves no pending timer behind; `stopped` makes the frame
    // return without touching the provider.
    settleMint?.(null)
  }
}
