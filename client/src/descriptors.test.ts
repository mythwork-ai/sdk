// Integrity guard for the AGE-69 descriptor table (@mythwork/protocol).
//
// tsc enforces that each entry's posture values are type-valid, but NOT that a
// given method has the RIGHT combination — a future edit could regress a
// posture to a type-valid-but-wrong pair (e.g. flip profile.update to
// result×result) and tsc would stay green. This locks the table's CONTENT.
//
// (It lives in the client suite because @mythwork/protocol is constants-only +
// zero-dependency by design and ships no test runner.) The BEHAVIORAL
// conformance — that the runtime actually honors signedOut/onError per method —
// is the api worker's descriptor-walking harness (myth-backend-api's half).

import { API_METHOD_DESCRIPTORS, type MethodMap } from '@mythwork/protocol'
import { describe, expect, it } from 'vitest'

const SIGNED_OUT = new Set(['anon', 'optional', 'throw', 'result'])
const ON_ERROR = new Set(['throw', 'result'])
const VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])

const auth = (m: keyof MethodMap) => API_METHOD_DESCRIPTORS[m]?.auth

describe('API_METHOD_DESCRIPTORS (AGE-69 table integrity)', () => {
  const entries = Object.entries(API_METHOD_DESCRIPTORS)

  it('every entry has a valid http binding + two-axis auth posture', () => {
    expect(entries.length).toBeGreaterThan(0)
    for (const [method, d] of entries) {
      if (!d) throw new Error(`${method}: empty descriptor`)
      expect(VERBS.has(d.http.verb), `${method} verb`).toBe(true)
      expect(d.http.path.startsWith('/'), `${method} path`).toBe(true)
      expect(SIGNED_OUT.has(d.auth.signedOut), `${method} signedOut`).toBe(true)
      expect(ON_ERROR.has(d.auth.onError), `${method} onError`).toBe(true)
    }
  })

  it('paginated is set only on the cursor-paged reads', () => {
    const paged = entries
      .filter(([, d]) => d?.paginated)
      .map(([m]) => m)
      .sort()
    expect(paged).toEqual(['explore.comments', 'explore.listApps'])
  })

  it('locks the postures the deployed bridges define', () => {
    // explore reads: attach-if-present, a stale 401 / 4xx propagates (throws).
    expect(auth('explore.listApps')).toEqual({ signedOut: 'optional', onError: 'throw' })
    expect(auth('explore.getApp')).toEqual({ signedOut: 'optional', onError: 'throw' })
    // explore engagement writes + the one viewer read + the owner app-meta
    // save: gated result on both axes.
    expect(auth('explore.rate')).toEqual({ signedOut: 'result', onError: 'result' })
    expect(auth('explore.myRatings')).toEqual({ signedOut: 'result', onError: 'result' })
    expect(auth('explore.updateAppMeta')).toEqual({ signedOut: 'result', onError: 'result' })
    // profile.me / submitClaim: gated result.
    expect(auth('profile.me')).toEqual({ signedOut: 'result', onError: 'result' })
    expect(auth('profile.submitClaim')).toEqual({ signedOut: 'result', onError: 'result' })
    // profile signed-in reads/mutations that throw on both axes.
    expect(auth('profile.myFavorites')).toEqual({ signedOut: 'throw', onError: 'throw' })
    expect(auth('profile.setNotificationPrefs')).toEqual({ signedOut: 'throw', onError: 'throw' })
    // the hybrid the two axes were introduced for: throw with no token, but map
    // a validation 4xx to { ok:false, reason } so a settings screen can show it.
    expect(auth('profile.update')).toEqual({ signedOut: 'throw', onError: 'result' })
    // ai.* — hard-gated signed-in "do it" actions on the separate mythwork-ai
    // worker: no token → throw, a non-2xx (incl. 402/429) → throw.
    expect(auth('ai.chat')).toEqual({ signedOut: 'throw', onError: 'throw' })
    expect(auth('ai.complete')).toEqual({ signedOut: 'throw', onError: 'throw' })
    // prompts.list — names-only read, gated-result on both axes.
    expect(auth('prompts.list')).toEqual({ signedOut: 'result', onError: 'result' })
  })

  it('binds ai.* to the single-endpoint worker root via POST', () => {
    expect(API_METHOD_DESCRIPTORS['ai.chat']?.http).toEqual({ verb: 'POST', path: '/' })
    expect(API_METHOD_DESCRIPTORS['ai.complete']?.http).toEqual({ verb: 'POST', path: '/' })
  })

  it('marks ai.chat and ai.complete as streaming', () => {
    expect(API_METHOD_DESCRIPTORS['ai.chat']?.streaming).toBe(true)
    expect(API_METHOD_DESCRIPTORS['ai.complete']?.streaming).toBe(true)
  })
})
