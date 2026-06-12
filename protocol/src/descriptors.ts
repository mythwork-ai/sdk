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
// explore/profile-me methods migrate onto this table as AGE-69
// implementation lands; until then the table carries the bootstrap entry.

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
 * @experimental The descriptor table (AGE-69). Bootstrap state: entry #1 —
 * `profile.submitClaim` — adopted by charter, plus `profile.me` (the first
 * method specified descriptor-first, before any hand-written bridge existed);
 * the served explore/profile-me methods migrate here when the bridge/route
 * interpreters land.
 */
export const API_METHOD_DESCRIPTORS: Partial<Record<keyof MethodMap, MethodDescriptor>> = {
  'profile.submitClaim': {
    http: { verb: 'POST', path: '/claim' },
    auth: 'gated-result',
  },
  'profile.me': {
    http: { verb: 'GET', path: '/profile/me' },
    auth: 'gated-result',
  },
}
