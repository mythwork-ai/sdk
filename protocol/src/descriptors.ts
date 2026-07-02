// Method descriptors: the single declaration that interpreters walk.
//
// One entry per API-backed wire method declaring its transport behavior — the
// facts the MethodMap's types cannot express and that every layer previously
// re-stated by hand (HTTP binding, auth posture, pagination). Interpreters:
// the host-iframe bridge (generic dispatch), the api worker route registry,
// and the descriptor-walking conformance harness.
//
// Host-local methods (fs.*, project.*, collab.*, kernel.*, db.*, ydocs.*,
// config.get) have no HTTP binding and never appear here. The explore and
// profile namespaces are fully declared below. The `ai.*` namespace also
// appears here, but binds to a SEPARATE backend (the `mythwork-ai` worker on
// ai.{zone}, resolved bridge-side) rather than the api worker.

import type { MethodMap } from './methods'

/**
 * @experimental What a method does when there is NO session token — the
 * bridge's no-token gate. The conformance harness derives the signed-out case
 * from it.
 *
 * - `anon` — never send a Bearer (a pure public read).
 * - `optional` — attach the token if present; a stale 401 propagates (THROWS),
 *   never a silent anonymous downgrade.
 * - `throw` — no token → throw `'sign in required'` with ZERO network.
 * - `result` — no token → `{ ok: false, reason: 'sign_in_required' }` as a
 *   RESULT with ZERO network.
 */
export type SignedOutPosture = 'anon' | 'optional' | 'throw' | 'result'

/**
 * @experimental What a method does on a non-2xx api response.
 *
 * - `throw` — a non-2xx throws `'<method> failed: <status>'`.
 * - `result` — a 4xx maps to `{ ok: false, reason }` (a renderable affordance,
 *   e.g. `handle_taken` / `no_profile`); a 5xx still throws (transient).
 */
export type ErrorPosture = 'throw' | 'result'

/**
 * @experimental How a method treats the viewer's session at the bridge — two
 * INDEPENDENT axes. The two-axis model is necessary because some methods cannot
 * be expressed by a single flat value: `profile.update` is
 * `signedOut: 'throw'` × `onError: 'result'` (throw with no token, but map a
 * validation 4xx to a reason). The axes are the real degrees of freedom, and
 * the harness derives a per-axis matrix (no-token case from `signedOut`, 4xx
 * case from `onError`).
 *
 * Common combinations:
 *   pure public read  → { signedOut: 'anon',     onError: 'throw'  }
 *   enriched read     → { signedOut: 'optional', onError: 'throw'  }
 *   hard gated        → { signedOut: 'throw',    onError: 'throw'  }
 *   gated with reason → { signedOut: 'result',   onError: 'result' }
 */
export interface AuthPosture {
  signedOut: SignedOutPosture
  onError: ErrorPosture
}

/**
 * @experimental Transport declaration for one API-backed wire method.
 */
export interface MethodDescriptor {
  /**
   * HTTP binding on the api worker. `path` may contain `:name` tokens
   * interpolated from params; remaining params go to the query string on
   * GET/DELETE (arrays repeated per value) or the JSON body otherwise.
   */
  http: { verb: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; path: string }
  auth: AuthPosture
  /**
   * Marks the `{ cursor? }` → `{ items, nextCursor? }` convention (nextCursor
   * absent on the last page); the conformance harness derives pagination
   * cases from it.
   */
  paginated?: boolean
  /**
   * When true, the method supports server-sent streaming via `stream: true` in
   * its params. The host bridge opens an SSE/streaming response and pushes
   * `ai.delta` events correlated by `requestId`.
   */
  streaming?: boolean
}

/**
 * @experimental The descriptor table. Covers the explore namespace (all 14
 * methods), the profile namespace methods, and the `ai.*` namespace (which
 * binds to the separate `mythwork-ai` worker, not the api worker). Host-local
 * namespaces never appear here.
 */
export const API_METHOD_DESCRIPTORS: Partial<Record<keyof MethodMap, MethodDescriptor>> = {
  // ── explore.* ────────────────────────────────────────────────────────────
  // Reads are public/anonymous-OK but enrich rows when a session is attached,
  // and a stale-token 401 propagates (no silent anonymous downgrade) →
  // signedOut: 'optional', onError: 'throw'. listApps + comments page via
  // { cursor? } → { nextCursor? }. The engagement writes (rate/clearRating/
  // addComment) and the one viewer read (myRatings) short-circuit to
  // { ok:false, reason } with ZERO network when signed out and map a 4xx to a
  // reason → signedOut: 'result', onError: 'result'.
  'explore.listApps': {
    http: { verb: 'GET', path: '/explore/apps' },
    auth: { signedOut: 'optional', onError: 'throw' },
    paginated: true,
  },
  'explore.getApp': {
    http: { verb: 'GET', path: '/explore/apps/:projectId' },
    auth: { signedOut: 'optional', onError: 'throw' },
  },
  'explore.relatedApps': {
    http: { verb: 'GET', path: '/explore/apps/:projectId/related' },
    auth: { signedOut: 'optional', onError: 'throw' },
  },
  'explore.trendingApps': {
    http: { verb: 'GET', path: '/explore/trending' },
    auth: { signedOut: 'optional', onError: 'throw' },
  },
  'explore.tags': {
    http: { verb: 'GET', path: '/explore/tags' },
    auth: { signedOut: 'optional', onError: 'throw' },
  },
  'explore.search': {
    http: { verb: 'GET', path: '/explore/search' },
    auth: { signedOut: 'optional', onError: 'throw' },
  },
  'explore.popularSearches': {
    http: { verb: 'GET', path: '/explore/popular-searches' },
    auth: { signedOut: 'optional', onError: 'throw' },
  },
  'explore.spotlight': {
    http: { verb: 'GET', path: '/explore/spotlight' },
    auth: { signedOut: 'optional', onError: 'throw' },
  },
  'explore.collections': {
    http: { verb: 'GET', path: '/explore/collections' },
    auth: { signedOut: 'optional', onError: 'throw' },
  },
  'explore.comments': {
    http: { verb: 'GET', path: '/explore/comments' },
    auth: { signedOut: 'optional', onError: 'throw' },
    paginated: true,
  },
  'explore.myRatings': {
    http: { verb: 'GET', path: '/explore/my-ratings' },
    auth: { signedOut: 'result', onError: 'result' },
  },
  'explore.rate': {
    http: { verb: 'POST', path: '/explore/rate' },
    auth: { signedOut: 'result', onError: 'result' },
  },
  'explore.clearRating': {
    http: { verb: 'DELETE', path: '/explore/rate' },
    auth: { signedOut: 'result', onError: 'result' },
  },
  'explore.addComment': {
    http: { verb: 'POST', path: '/explore/comments' },
    auth: { signedOut: 'result', onError: 'result' },
  },
  // Owner-update of app metadata — a save button, so gated-result on BOTH axes
  // (a 403 not-owner / 404 surfaces as { ok:false, reason }, never a throw).
  // PATCH REST-pairs with GET /explore/apps/:projectId.
  'explore.updateAppMeta': {
    http: { verb: 'PATCH', path: '/explore/apps/:projectId' },
    auth: { signedOut: 'result', onError: 'result' },
  },
  // Owner-lifecycle actions — reversible unpublish and permanent soft-delete.
  // Gated-result on BOTH axes: signed-out resolves { ok:false } with ZERO
  // network; a non-owner / unknown projectId → { ok:false, reason:'forbidden' }.
  'explore.unpublish': {
    http: { verb: 'POST', path: '/explore/apps/:projectId/unpublish' },
    auth: { signedOut: 'result', onError: 'result' },
  },
  'explore.deleteApp': {
    http: { verb: 'POST', path: '/explore/apps/:projectId/delete' },
    auth: { signedOut: 'result', onError: 'result' },
  },

  // ── profile.* ────────────────────────────────────────────────────────────
  // submitClaim + me: no-token → { ok:false } ZERO network, a stale 401 + a 4xx
  // map to { ok:false, reason } → signedOut: 'result', onError: 'result'.
  // myFavorites + the notification-prefs pair THROW on no-token AND on any
  // non-2xx → signedOut: 'throw', onError: 'throw'. profile.update is the
  // canonical two-axis hybrid: it THROWS with no token but maps a 400/403/404
  // to { ok:false, reason } (so a settings screen renders the reason) →
  // signedOut: 'throw', onError: 'result'.
  'profile.submitClaim': {
    http: { verb: 'POST', path: '/claim' },
    auth: { signedOut: 'result', onError: 'result' },
  },
  'profile.me': {
    http: { verb: 'GET', path: '/profile/me' },
    auth: { signedOut: 'result', onError: 'result' },
  },
  'profile.update': {
    http: { verb: 'PATCH', path: '/profile/me' },
    auth: { signedOut: 'throw', onError: 'result' },
  },
  'profile.myFavorites': {
    http: { verb: 'GET', path: '/profile/me/favorites' },
    auth: { signedOut: 'throw', onError: 'throw' },
  },
  'profile.getNotificationPrefs': {
    http: { verb: 'GET', path: '/profile/me/notification-prefs' },
    auth: { signedOut: 'throw', onError: 'throw' },
  },
  'profile.setNotificationPrefs': {
    http: { verb: 'PUT', path: '/profile/me/notification-prefs' },
    auth: { signedOut: 'throw', onError: 'throw' },
  },

  // ── prompts.* ────────────────────────────────────────────────────────────
  // Names-only read of a project's prompt presets. Gated-result on both axes:
  // signed-out → { ok:false } with ZERO network; a 4xx → { ok:false, reason }.
  // The :projectId in the path is filled host-side from the trusted current
  // project (Correction A) — the client sends no projectId.
  'prompts.list': {
    http: { verb: 'GET', path: '/prompts/:projectId' },
    auth: { signedOut: 'result', onError: 'result' },
  },

  // ── ai.* ───────────────────────────────────────────────────────────────────
  // The ONE exception to "every entry binds to the api worker": the `ai.*`
  // methods POST to the SEPARATE `mythwork-ai` worker origin (ai.{zone}),
  // resolved bridge-side via origin-config — `http.path` here is the
  // single-endpoint worker root, NOT an api-worker route. Both are hard-gated
  // signed-in "do it" actions (the worker 401s without a session), so they
  // THROW on both axes, exactly like profile.myFavorites / the notification-pref
  // writes: no token → throw 'sign in required' with ZERO network; a non-2xx
  // (incl. 402 out-of-credits / 429 rate-limited) throws.
  'ai.chat': {
    http: { verb: 'POST', path: '/' },
    auth: { signedOut: 'throw', onError: 'throw' },
    streaming: true,
  },
  'ai.complete': {
    http: { verb: 'POST', path: '/' },
    auth: { signedOut: 'throw', onError: 'throw' },
    streaming: true,
  },
}
