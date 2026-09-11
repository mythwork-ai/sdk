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
import { MythworkClient } from './client'

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
    expect(paged).toEqual([
      'explore.comments',
      'explore.listApps',
      'explore.listRemixes',
      'explore.myApps',
      'explore.sharedWithMe',
      'notifications.list',
      'notifications.listUnread',
      'profile.listFollowers',
      'stacks.discover',
    ])
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
    // profile.listFollowers: a pure public read — never sends a Bearer, and an
    // unknown handle throws (the handle IS the resource).
    expect(auth('profile.listFollowers')).toEqual({ signedOut: 'anon', onError: 'throw' })
    // profile signed-in reads/mutations that throw on both axes.
    expect(auth('profile.myFavorites')).toEqual({ signedOut: 'throw', onError: 'throw' })
    expect(auth('profile.setNotificationPrefs')).toEqual({ signedOut: 'throw', onError: 'throw' })
    expect(auth('notifications.list')).toEqual({ signedOut: 'throw', onError: 'throw' })
    expect(auth('notifications.getUnreadCount')).toEqual({ signedOut: 'throw', onError: 'throw' })
    // the hybrid the two axes were introduced for: throw with no token, but map
    // a validation 4xx to { ok:false, reason } so a settings screen can show it.
    expect(auth('profile.update')).toEqual({ signedOut: 'throw', onError: 'result' })
    // ai.* — hard-gated signed-in "do it" actions on the separate mythwork-ai
    // worker: no token → throw, a non-2xx (incl. 402/429) → throw.
    expect(auth('ai.chat')).toEqual({ signedOut: 'throw', onError: 'throw' })
    expect(auth('ai.complete')).toEqual({ signedOut: 'throw', onError: 'throw' })
    // prompts.list — names-only read, gated-result on both axes.
    expect(auth('prompts.list')).toEqual({ signedOut: 'result', onError: 'result' })
    // stacks.* writes: gated result, same as explore engagement writes.
    expect(auth('stacks.rename')).toEqual({ signedOut: 'result', onError: 'result' })
    // stacks.resolveShare + stacks.discover — the two public/anon-OK reads in
    // this namespace, unlike every other stacks.* method (which all
    // throw/gated-result as signed-in-only). Matches the explore-reads
    // posture exactly.
    expect(auth('stacks.resolveShare')).toEqual({ signedOut: 'optional', onError: 'throw' })
    expect(auth('stacks.discover')).toEqual({ signedOut: 'optional', onError: 'throw' })
  })

  it('binds ai.* to the single-endpoint worker root via POST', () => {
    expect(API_METHOD_DESCRIPTORS['ai.chat']?.http).toEqual({ verb: 'POST', path: '/' })
    expect(API_METHOD_DESCRIPTORS['ai.complete']?.http).toEqual({ verb: 'POST', path: '/' })
  })

  it('marks ai.chat and ai.complete as streaming', () => {
    expect(API_METHOD_DESCRIPTORS['ai.chat']?.streaming).toBe(true)
    expect(API_METHOD_DESCRIPTORS['ai.complete']?.streaming).toBe(true)
  })

  it('binds database.* to the api worker projectdb routes', () => {
    expect(API_METHOD_DESCRIPTORS['database.list']?.http).toEqual({
      verb: 'GET',
      path: '/projects/:pid/entities/:entity',
    })
    expect(API_METHOD_DESCRIPTORS['database.get']?.http).toEqual({
      verb: 'GET',
      path: '/projects/:pid/entities/:entity/:id',
    })
    expect(API_METHOD_DESCRIPTORS['database.count']?.http).toEqual({
      verb: 'GET',
      path: '/projects/:pid/entities/:entity/count',
    })
    expect(API_METHOD_DESCRIPTORS['database.create']?.http).toEqual({
      verb: 'POST',
      path: '/projects/:pid/entities/:entity',
    })
    expect(API_METHOD_DESCRIPTORS['database.update']?.http).toEqual({
      verb: 'PATCH',
      path: '/projects/:pid/entities/:entity/:id',
    })
    expect(API_METHOD_DESCRIPTORS['database.delete']?.http).toEqual({
      verb: 'DELETE',
      path: '/projects/:pid/entities/:entity/:id',
    })
    expect(API_METHOD_DESCRIPTORS['database.schema']?.http).toEqual({
      verb: 'GET',
      path: '/projects/:pid/schema',
    })
  })

  it('locks the database.* postures: enriched reads, hard-gated writes', () => {
    // The four reads (list/get/count/schema): attach-if-present, a stale 401
    // propagates rather than downgrading to anonymous — same posture as the
    // explore namespace's reads.
    expect(auth('database.list')).toEqual({ signedOut: 'optional', onError: 'throw' })
    expect(auth('database.get')).toEqual({ signedOut: 'optional', onError: 'throw' })
    expect(auth('database.count')).toEqual({ signedOut: 'optional', onError: 'throw' })
    expect(auth('database.schema')).toEqual({ signedOut: 'optional', onError: 'throw' })
    // The three writes (create/update/delete): every verb in the SDK
    // surface's contract resolves or rejects, and MethodMap carries no
    // refusal-variant union, so a signed-out call or a per-row rule denial
    // both reject rather than resolve as data.
    expect(auth('database.create')).toEqual({ signedOut: 'throw', onError: 'throw' })
    expect(auth('database.update')).toEqual({ signedOut: 'throw', onError: 'throw' })
    expect(auth('database.delete')).toEqual({ signedOut: 'throw', onError: 'throw' })
  })

  it('leaves database.list out of the cursor-paginated set', () => {
    // The contract's list page is { where, sort, limit, starting_after } →
    // { rows, next } — a different convention from the { cursor? } →
    // { items, nextCursor? } shape `paginated` marks, so database.list must
    // stay unset rather than misread by the conformance harness.
    expect(API_METHOD_DESCRIPTORS['database.list']?.paginated).toBeUndefined()
  })
})

/**
 * A declared method with no client binding is invisible to every consumer.
 *
 * `explore.setPinned` shipped its protocol type, its descriptor, its bridge
 * and its route, and was never added to `client.explore` — so a caller
 * probing `typeof sdk.explore.setPinned === "function"` got false forever and
 * the whole feature was inert with nothing failing anywhere. tsc cannot catch
 * it: an absent property on an object literal is not an error, only an
 * absent USE of one.
 *
 * Scoped to `explore.*` because that surface is a flat one-to-one namespace.
 * Other namespaces deliberately rename across the wire (`auth.getUser` →
 * `kernel.getUser`) or expose a method under a different shape, so a blanket
 * rule there would be wrong rather than useful.
 */
describe('client bindings cover the declared surface', () => {
  it('binds every explore.* method the descriptor table declares', () => {
    const chan = new MessageChannel()
    try {
      const client = new MythworkClient(chan.port1)
      const bound = new Set(Object.keys(client.explore))
      const declared = Object.keys(API_METHOD_DESCRIPTORS)
        .filter(m => m.startsWith('explore.'))
        .map(m => m.slice('explore.'.length))

      expect(declared.length).toBeGreaterThan(0)
      const missing = declared.filter(name => !bound.has(name))
      expect(missing, `declared but not bound on client.explore: ${missing.join(', ')}`).toEqual([])
    } finally {
      chan.port1.close()
      chan.port2.close()
    }
  })
})
