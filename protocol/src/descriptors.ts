// AGE-69 method descriptors: the single declaration that interpreters walk.
//
// Spec: docs/superpowers/specs/2026-06-12-age-69-method-descriptors.md.
// One entry per API-BACKED wire method declaring its transport behavior — the
// facts the MethodMap's types cannot express and that every layer previously
// re-stated by hand (HTTP binding, auth posture, pagination). Interpreters:
// the host-iframe bridge (generic dispatch), the api worker route registry,
// and the descriptor-walking conformance harness (all myth-backend-api's
// half of the charter).
//
// Host-local methods (fs.*, project.*, collab.*, kernel.*, db.*, ydocs.*,
// config.get) have no HTTP binding and never appear here. The deployed
// explore + /me-era profile methods are declared below; the bridge/route
// interpreters that walk this table are myth-backend-api's half (in progress).

import type { MethodMap } from './methods'

/**
 * @experimental How a method treats the viewer's session at the bridge.
 *
 * - `anon` — never sends a Bearer.
 * - `optional-bearer` — attach the token if present; a stale 401 THROWS
 *   (no silent anonymous downgrade).
 * - `gated-result` — no token → `{ ok: false, reason: 'sign_in_required' }`
 *   returned as a RESULT with ZERO network; api 4xx maps to
 *   `{ ok: false, reason }`.
 * - `gated-throw` — no token → throw `'sign in required'`; non-2xx throws
 *   (the deployed legacy `profile.*` posture).
 */
export type AuthPosture = 'anon' | 'optional-bearer' | 'gated-result' | 'gated-throw'

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
}

/**
 * @experimental The descriptor table (AGE-69). Covers the explore namespace
 * (all 14 methods) and the /me-era profile methods, grounded against the
 * deployed host-iframe bridges (`bridges/explore.ts`, `bridges/profile.ts`) +
 * the api-worker routes — zero bridge↔route drift at authoring time.
 *
 * `profile.update` is intentionally ABSENT: its posture is a hybrid the
 * 4-value {@link AuthPosture} can't express (no-token THROWS, but a 400/403/404
 * maps to `{ ok:false, reason }`), so it keeps its hand-written bridge until
 * the posture model is resolved — see the note at the end of the table.
 *
 * The legacy `profile.*` methods (get/discover/claimHandle/setContentProject/
 * setFavorite) also stay hand-written (`gated-throw`) until someone needs to
 * touch them; host-local namespaces never appear here.
 */
export const API_METHOD_DESCRIPTORS: Partial<Record<keyof MethodMap, MethodDescriptor>> = {
  // ── explore.* (the mythwork#296 bridge) ──────────────────────────────────
  // Reads are public/anonymous-OK but enrich rows when a session is attached,
  // and a stale-token 401 propagates (no silent anonymous downgrade) →
  // `optional-bearer`. listApps + comments page via { cursor? } → { nextCursor? }.
  // The engagement writes (rate/clearRating/addComment) and the one viewer read
  // (myRatings) short-circuit to { ok:false, reason } with ZERO network when
  // signed out → `gated-result`.
  'explore.listApps': {
    http: { verb: 'GET', path: '/explore/apps' },
    auth: 'optional-bearer',
    paginated: true,
  },
  'explore.getApp': {
    http: { verb: 'GET', path: '/explore/apps/:projectId' },
    auth: 'optional-bearer',
  },
  'explore.relatedApps': {
    http: { verb: 'GET', path: '/explore/apps/:projectId/related' },
    auth: 'optional-bearer',
  },
  'explore.trendingApps': {
    http: { verb: 'GET', path: '/explore/trending' },
    auth: 'optional-bearer',
  },
  'explore.tags': {
    http: { verb: 'GET', path: '/explore/tags' },
    auth: 'optional-bearer',
  },
  'explore.search': {
    http: { verb: 'GET', path: '/explore/search' },
    auth: 'optional-bearer',
  },
  'explore.popularSearches': {
    http: { verb: 'GET', path: '/explore/popular-searches' },
    auth: 'optional-bearer',
  },
  'explore.spotlight': {
    http: { verb: 'GET', path: '/explore/spotlight' },
    auth: 'optional-bearer',
  },
  'explore.collections': {
    http: { verb: 'GET', path: '/explore/collections' },
    auth: 'optional-bearer',
  },
  'explore.comments': {
    http: { verb: 'GET', path: '/explore/comments' },
    auth: 'optional-bearer',
    paginated: true,
  },
  'explore.myRatings': {
    http: { verb: 'GET', path: '/explore/my-ratings' },
    auth: 'gated-result',
  },
  'explore.rate': {
    http: { verb: 'POST', path: '/explore/rate' },
    auth: 'gated-result',
  },
  'explore.clearRating': {
    http: { verb: 'DELETE', path: '/explore/rate' },
    auth: 'gated-result',
  },
  'explore.addComment': {
    http: { verb: 'POST', path: '/explore/comments' },
    auth: 'gated-result',
  },

  // ── profile.* (the /me-era additions; mythwork#296/#311) ──────────────────
  // submitClaim + me use `gated-result` (no-token → { ok:false } with ZERO
  // network; a stale 401 + a 4xx map to { ok:false, reason }; 5xx throws).
  // myFavorites + the notification-prefs pair THROW on no-token AND on any
  // non-2xx → `gated-throw`.
  'profile.submitClaim': {
    http: { verb: 'POST', path: '/claim' },
    auth: 'gated-result',
  },
  'profile.me': {
    http: { verb: 'GET', path: '/profile/me' },
    auth: 'gated-result',
  },
  'profile.myFavorites': {
    http: { verb: 'GET', path: '/profile/me/favorites' },
    auth: 'gated-throw',
  },
  'profile.getNotificationPrefs': {
    http: { verb: 'GET', path: '/profile/me/notification-prefs' },
    auth: 'gated-throw',
  },
  'profile.setNotificationPrefs': {
    http: { verb: 'PUT', path: '/profile/me/notification-prefs' },
    auth: 'gated-throw',
  },

  // profile.update is DEFERRED: it's a HYBRID the 4-value AuthPosture can't
  // express — no-token THROWS (like gated-throw) but a 400/403/404 maps to
  // { ok:false, reason } (like gated-result), per bridges/profile.ts. Encoding
  // it as either value would make the descriptor-walking conformance harness
  // assert the wrong 4xx behavior. Resolve the model with myth-backend-api
  // (interpreter owner) before adding it — likely a 5th posture, or splitting
  // `auth` into independent (no-token, error-map) axes. Until then profile.update
  // keeps its hand-written bridge.
}
