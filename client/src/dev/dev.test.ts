// Integration tests for the SDK dev host.
//
// Drive a REAL MythworkClient over the dev host via both:
//   (a) new MythworkClient(createDevHost())         — direct construction
//   (b) await connect({ dev: true })                — idiomatic API
//
// Coverage: listApps, tag filter, sort, gated-RESULT posture (explore writes),
// THROW posture (profile.* mutations), signIn → authChanged push → setFavorite
// succeeds → myFavorites reflects it, addComment + threaded replies,
// profile.me three states, profile.get for a seed handle, unknown method.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect } from '../index'
import { MythworkClient } from '../client'
import { createDevHost } from './host'
import { SEED_APPS, SEED_MAKERS } from './seed'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeClient(): MythworkClient {
  return new MythworkClient(createDevHost())
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('connect({ dev: true })', () => {
  it('returns a MythworkClient without a real host', async () => {
    const sdk = await connect({ dev: true })
    expect(sdk).toBeInstanceOf(MythworkClient)
    // Spot-check: can call a method
    const { items } = await sdk.explore.listApps()
    expect(items.length).toBeGreaterThan(0)
  })
})

describe('explore.listApps', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('returns all seed apps by default (popular sort)', async () => {
    const { items } = await sdk.explore.listApps()
    expect(items.length).toBe(SEED_APPS.length)
    // Popular sort: launches descending
    for (let i = 0; i < items.length - 1; i++) {
      expect(items[i]!.launches).toBeGreaterThanOrEqual(items[i + 1]!.launches)
    }
  })

  it('filters by tag (all-of semantics)', async () => {
    const { items } = await sdk.explore.listApps({ tags: ['Automation'] })
    expect(items.length).toBeGreaterThan(0)
    for (const app of items) {
      expect(app.tags).toContain('Automation')
    }
    // Multiple tags: only apps that have ALL tags
    const { items: narrow } = await sdk.explore.listApps({ tags: ['Automation', 'Workflow'] })
    expect(narrow.length).toBeLessThanOrEqual(items.length)
    for (const app of narrow) {
      expect(app.tags).toContain('Automation')
      expect(app.tags).toContain('Workflow')
    }
  })

  it('sort=new returns apps newest first (publishedAt desc)', async () => {
    const { items } = await sdk.explore.listApps({ sort: 'new' })
    for (let i = 0; i < items.length - 1; i++) {
      expect(items[i]!.publishedAt).toBeGreaterThanOrEqual(items[i + 1]!.publishedAt)
    }
  })

  it('sort=trending returns apps by trendPct desc', async () => {
    const { items } = await sdk.explore.listApps({ sort: 'trending' })
    for (let i = 0; i < items.length - 1; i++) {
      expect(items[i]!.trendPct ?? 0).toBeGreaterThanOrEqual(items[i + 1]!.trendPct ?? 0)
    }
  })

  it('filters by maker handle', async () => {
    const makerHandle = SEED_MAKERS[0]!.handle // 'devuser' has multiple apps
    const { items } = await sdk.explore.listApps({ maker: makerHandle })
    expect(items.length).toBeGreaterThan(0)
    for (const app of items) {
      expect(app.maker.handle).toBe(makerHandle)
    }
  })
})

describe('explore.getApp', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('returns AppDetail for a known projectId', async () => {
    const first = SEED_APPS[0]!
    const detail = await sdk.explore.getApp({ projectId: first.projectId })
    expect(detail.projectId).toBe(first.projectId)
    expect(detail.name).toBe(first.name)
    expect(typeof detail.remixCount).toBe('number')
  })

  it('throws for an unknown projectId', async () => {
    await expect(sdk.explore.getApp({ projectId: 'nonexistent' })).rejects.toThrow()
  })
})

describe('explore.trendingApps', () => {
  it('returns the trending rail', async () => {
    const sdk = makeClient()
    const { items } = await sdk.explore.trendingApps()
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThanOrEqual(SEED_APPS.length)
    sdk.port.close()
  })
})

describe('explore.tags', () => {
  it('returns tag counts for all seed tags', async () => {
    const sdk = makeClient()
    const { items } = await sdk.explore.tags()
    expect(items.length).toBeGreaterThan(0)
    for (const tc of items) {
      expect(tc.count).toBeGreaterThan(0)
    }
    sdk.port.close()
  })
})

describe('explore.search', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('returns matching apps and makers', async () => {
    const { apps, makers } = await sdk.explore.search({ q: 'automation' })
    expect(apps.length).toBeGreaterThan(0)
    for (const app of apps) {
      const fields = [app.name, app.tagline, ...app.tags, app.maker.handle, app.maker.displayName]
      expect(fields.some(f => f.toLowerCase().includes('auto'))).toBe(true)
    }
    // makers is present (may be empty for this query)
    expect(Array.isArray(makers)).toBe(true)
  })

  it('@handle search finds matching maker', async () => {
    const handle = SEED_MAKERS[0]!.handle
    const { makers } = await sdk.explore.search({ q: `@${handle}` })
    expect(makers.length).toBeGreaterThan(0)
    expect(makers[0]!.handle).toBe(handle)
  })

  it('empty query returns all apps', async () => {
    const { apps } = await sdk.explore.search({ q: '' })
    expect(apps.length).toBe(SEED_APPS.length)
  })
})

describe('explore.relatedApps', () => {
  it('returns apps sharing a tag with the given projectId', async () => {
    const sdk = makeClient()
    const source = SEED_APPS[0]!
    const { items } = await sdk.explore.relatedApps({ projectId: source.projectId })
    expect(items.length).toBeGreaterThan(0)
    for (const related of items) {
      expect(related.projectId).not.toBe(source.projectId)
      const shared = related.tags.some(t => source.tags.includes(t))
      expect(shared).toBe(true)
    }
    sdk.port.close()
  })
})

describe('explore.spotlight / collections / popularSearches', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('spotlight returns a SpotlightItem', async () => {
    const { item } = await sdk.explore.spotlight()
    expect(item).not.toBeNull()
    expect(item!.projectId).toBeTruthy()
    expect(item!.kicker).toBeTruthy()
  })

  it('collections returns at least one CollectionInfo', async () => {
    const { items } = await sdk.explore.collections()
    expect(items.length).toBeGreaterThan(0)
    expect(items[0]!.id).toBeTruthy()
  })

  it('popularSearches returns string[]', async () => {
    const { items } = await sdk.explore.popularSearches()
    expect(items.length).toBeGreaterThan(0)
    expect(typeof items[0]).toBe('string')
  })
})

describe('explore gated-RESULT posture (signed-out)', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('explore.rate signed-out returns { ok:false, reason:"sign_in_required" }', async () => {
    const result = await sdk.explore.rate({ projectId: SEED_APPS[0]!.projectId, stars: 4 })
    expect(result).toEqual({ ok: false, reason: 'sign_in_required' })
  })

  it('explore.clearRating signed-out returns { ok:false, reason:"sign_in_required" }', async () => {
    const result = await sdk.explore.clearRating({ projectId: SEED_APPS[0]!.projectId })
    expect(result).toEqual({ ok: false, reason: 'sign_in_required' })
  })

  it('explore.myRatings signed-out returns { ok:false, reason:"sign_in_required" }', async () => {
    const result = await sdk.explore.myRatings()
    expect(result).toEqual({ ok: false, reason: 'sign_in_required' })
  })

  it('explore.addComment signed-out returns { ok:false, reason:"sign_in_required" }', async () => {
    const result = await sdk.explore.addComment({
      projectId: SEED_APPS[0]!.projectId,
      body: 'hello',
    })
    expect(result).toEqual({ ok: false, reason: 'sign_in_required' })
  })
})

describe('profile.* THROW posture (signed-out)', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('profile.setFavorite signed-out rejects (throws)', async () => {
    await expect(
      sdk.profile.setFavorite({ targetKind: 'app', targetId: SEED_APPS[0]!.projectId }),
    ).rejects.toThrow()
  })

  it('profile.myFavorites signed-out rejects (throws)', async () => {
    await expect(sdk.profile.myFavorites()).rejects.toThrow()
  })

  it('profile.update signed-out rejects (throws)', async () => {
    await expect(sdk.profile.update({ displayName: 'New Name' })).rejects.toThrow()
  })
})

describe('ai.* (mythwork-ai dev mock)', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('ai.complete signed-out rejects (sign-in required)', async () => {
    await expect(sdk.ai.complete('hello')).rejects.toThrow(/sign in/i)
  })

  it('ai.chat signed-out rejects (sign-in required)', async () => {
    await expect(sdk.ai.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/sign in/i)
  })

  it('ai.complete returns the assistant text after signIn', async () => {
    await sdk.auth.signIn()
    const text = await sdk.ai.complete('hello')
    expect(text).toContain('hello')
  })

  it('ai.chat returns the assistant message after signIn', async () => {
    await sdk.auth.signIn()
    const msg = await sdk.ai.chat([{ role: 'user', content: 'ping' }])
    expect(msg.role).toBe('assistant')
    expect(typeof msg.content).toBe('string')
    expect(msg.content).toContain('ping')
  })
})

describe('ai.* firstParty mode (anonymous allowlisted-app simulation)', () => {
  let sdk: MythworkClient

  afterEach(() => {
    sdk.port.close()
  })

  it('anonymous ai.complete resolves to a (dev) echo (no sign-in throw)', async () => {
    sdk = await connect({ dev: { firstParty: true } })
    const text = await sdk.ai.complete('hello')
    expect(text).toContain('hello')
  })

  it('anonymous ai.chat resolves to an assistant message (no sign-in throw)', async () => {
    sdk = await connect({ dev: { firstParty: true } })
    const msg = await sdk.ai.chat([{ role: 'user', content: 'ping' }])
    expect(msg.role).toBe('assistant')
    expect(typeof msg.content).toBe('string')
    expect(msg.content).toContain('ping')
  })

  it('a signed-in caller still works in firstParty mode (regression)', async () => {
    sdk = await connect({ dev: { firstParty: true } })
    await sdk.auth.signIn()
    const text = await sdk.ai.complete('hi there')
    expect(text).toContain('hi there')
  })

  it('default mode (dev:true) still throws for anonymous ai.* (non-allowlisted app)', async () => {
    sdk = await connect({ dev: true })
    await expect(sdk.ai.complete('hello')).rejects.toThrow(/sign in/i)
    await expect(sdk.ai.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/sign in/i)
  })
})

describe('ai.* streaming (onChunk dev host)', () => {
  it('ai.complete with onChunk fires ≥1 delta and concat equals the resolved text', async () => {
    const sdk = await connect({ dev: { firstParty: true } })
    const chunks: string[] = []
    const text = await sdk.ai.complete('hi', { onChunk: d => chunks.push(d) })
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(chunks.join('')).toBe(text)
    sdk.port.close()
  })

  it('ai.complete without onChunk still returns the full text (non-streaming path)', async () => {
    const sdk = await connect({ dev: { firstParty: true } })
    const text = await sdk.ai.complete('hello world')
    expect(typeof text).toBe('string')
    expect(text).toContain('hello world')
    sdk.port.close()
  })

  it('signed-out non-firstParty rejects even with onChunk (posture unchanged)', async () => {
    const sdk = await connect({ dev: true })
    await expect(sdk.ai.complete('hello', { onChunk: () => {} })).rejects.toThrow(/sign in/i)
    sdk.port.close()
  })

  it('ai.chat with onChunk fires ≥1 delta and concat equals resolved content', async () => {
    const sdk = await connect({ dev: { firstParty: true } })
    const chunks: string[] = []
    const msg = await sdk.ai.chat([{ role: 'user', content: 'hi' }], {
      onChunk: d => chunks.push(d),
    })
    expect(chunks.length).toBeGreaterThanOrEqual(1)
    expect(msg.content).toBe(chunks.join(''))
    sdk.port.close()
  })
})

describe('nav.topLevel (first-party-gated dev mock)', () => {
  it('rejects for a non-first-party dev host', async () => {
    const sdk = await connect({ dev: true })
    await expect(sdk.nav.topLevel({ target: 'explore' })).rejects.toThrow(/first-party/i)
    sdk.port.close()
  })

  it('resolves { ok: true } for a first-party dev host (no real navigation)', async () => {
    const sdk = await connect({ dev: { firstParty: true } })
    await expect(sdk.nav.topLevel({ target: 'explore' })).resolves.toEqual({ ok: true })
    sdk.port.close()
  })

  it('rejects an unrecognized target even in first-party mode', async () => {
    const sdk = await connect({ dev: { firstParty: true } })
    await expect(sdk.nav.topLevel({ target: 'bogus' as unknown as 'explore' })).rejects.toThrow(
      /unknown target/i,
    )
    sdk.port.close()
  })
})

describe('kernel.getUser', () => {
  it('returns anonymous sentinel when signed out', async () => {
    const sdk = makeClient()
    const user = await sdk.auth.getUser()
    expect(user).toEqual({ kind: 'anonymous', userId: 'anonymous' })
    sdk.port.close()
  })
})

describe('signIn → push → signed-in operations', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('signIn returns a public user', async () => {
    const user = await sdk.auth.signIn()
    expect(user.kind).toBe('public')
    if (user.kind === 'public') {
      expect(user.displayName).toBeTruthy()
      expect(user.userId).toBeTruthy()
    }
  })

  it('signIn emits a kernel.authChanged push', async () => {
    const received: unknown[] = []
    sdk.auth.onAuthChanged(payload => {
      received.push(payload)
    })
    await sdk.auth.signIn()
    // Allow microtask tick for the push to propagate
    await new Promise(r => setTimeout(r, 10))
    expect(received.length).toBeGreaterThan(0)
    const push = received[0] as { type: string; user: { kind: string } }
    expect(push.type).toBe('kernel.authChanged')
    expect(push.user.kind).toBe('public')
  })

  it('setFavorite succeeds after signIn', async () => {
    await sdk.auth.signIn()
    const projectId = SEED_APPS[0]!.projectId
    const result = await sdk.profile.setFavorite({ targetKind: 'app', targetId: projectId })
    expect(result).toMatchObject({ ok: true, favorited: true })
  })

  it('myFavorites reflects setFavorite', async () => {
    await sdk.auth.signIn()
    const projectId = SEED_APPS[0]!.projectId
    await sdk.profile.setFavorite({ targetKind: 'app', targetId: projectId })
    const { items } = await sdk.profile.myFavorites()
    const found = items.find(e => e.targetKind === 'app' && e.targetId === projectId)
    expect(found).toBeDefined()
  })

  it('explore.rate succeeds after signIn', async () => {
    await sdk.auth.signIn()
    const projectId = SEED_APPS[0]!.projectId
    const result = await sdk.explore.rate({ projectId, stars: 5 })
    expect(result).toEqual({ ok: true })
  })

  it('explore.myRatings returns the rating after signIn + rate', async () => {
    await sdk.auth.signIn()
    const projectId = SEED_APPS[0]!.projectId
    await sdk.explore.rate({ projectId, stars: 3 })
    const result = await sdk.explore.myRatings()
    expect('ratings' in result).toBe(true)
    if ('ratings' in result) {
      expect(result.ratings[projectId]).toBe(3)
    }
  })

  it('signOut returns anonymous user and emits authChanged push', async () => {
    // Allow signIn's async push to drain before subscribing.
    await sdk.auth.signIn()
    await new Promise(r => setTimeout(r, 10))
    // Now subscribe; only the signOut push should arrive.
    const pushes: unknown[] = []
    sdk.auth.onAuthChanged(p => pushes.push(p))
    const user = await sdk.auth.signOut()
    expect(user).toEqual({ kind: 'anonymous', userId: 'anonymous' })
    await new Promise(r => setTimeout(r, 10))
    expect(pushes.length).toBeGreaterThan(0)
    const push = pushes[0] as { user: { kind: string } }
    expect(push.user.kind).toBe('anonymous')
  })
})

describe('explore.addComment + threaded replies', () => {
  let sdk: MythworkClient

  beforeEach(async () => {
    sdk = makeClient()
    await sdk.auth.signIn()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('addComment returns the new CommentNode', async () => {
    const projectId = SEED_APPS[3]!.projectId // app with no seed comments
    const result = await sdk.explore.addComment({ projectId, body: 'Great work!' })
    expect('id' in result).toBe(true)
    if ('id' in result) {
      expect(result.id).toMatch(/^dev-c/)
      expect(result.body).toBe('Great work!')
      expect(Array.isArray(result.replies)).toBe(true)
    }
  })

  it('added comment appears in comments list', async () => {
    const projectId = SEED_APPS[3]!.projectId
    await sdk.explore.addComment({ projectId, body: 'First comment' })
    const { items } = await sdk.explore.comments({ projectId })
    const found = items.find(c => c.body === 'First comment')
    expect(found).toBeDefined()
  })

  it('seed comments are returned for seeded apps', async () => {
    // app_dev_001 has seeded comments
    const { items } = await sdk.explore.comments({ projectId: 'app_dev_001' })
    expect(items.length).toBeGreaterThan(0)
    expect(items.some(c => c.replies.length > 0)).toBe(true)
  })

  it('reply to a top-level comment (parentCommentId)', async () => {
    const projectId = 'app_dev_001' // has seeded comment sc-c1
    const { items: before } = await sdk.explore.comments({ projectId })
    const parent = before[0]!
    const result = await sdk.explore.addComment({
      projectId,
      body: 'Replying to first comment',
      parentCommentId: parent.id,
    })
    expect('id' in result).toBe(true)
    // Verify reply appears in the parent's replies
    const { items: after } = await sdk.explore.comments({ projectId })
    const updatedParent = after.find(c => c.id === parent.id)
    expect(updatedParent!.replies.some(r => r.body === 'Replying to first comment')).toBe(true)
  })

  it('addComment before comments preserves seeded entries', async () => {
    // Regression: addComment used to initialize state.comments[projectId] with
    // an empty array, dropping seed fixtures when it ran before comments().
    const projectId = 'app_dev_001' // has seeded sc-c1, sc-c2
    await sdk.explore.addComment({ projectId, body: 'Added before read' })
    const { items } = await sdk.explore.comments({ projectId })
    expect(items.some(c => c.id === 'sc-c1')).toBe(true)
    expect(items.some(c => c.id === 'sc-c2')).toBe(true)
    expect(items.some(c => c.body === 'Added before read')).toBe(true)
  })

  it('reply to a seeded parent works before comments() is called', async () => {
    // Regression: with the seed dropped, parent lookup returned not_found.
    const projectId = 'app_dev_001'
    const result = await sdk.explore.addComment({
      projectId,
      body: 'Reply to seeded parent',
      parentCommentId: 'sc-c1',
    })
    expect('id' in result).toBe(true)
  })
})

describe('profile.me — three states', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('signed-out returns { ok:false, reason:"sign_in_required" }', async () => {
    const result = await sdk.profile.me()
    expect(result).toMatchObject({ ok: false, reason: 'sign_in_required' })
  })

  it('signed-in as seed maker returns full profile with isOwner:true', async () => {
    await sdk.auth.signIn()
    const result = await sdk.profile.me()
    // Should NOT have 'reason' in result
    expect('reason' in result).toBe(false)
    expect(result).toMatchObject({ isOwner: true })
    if ('handle' in result) {
      expect(result.handle).toBeTruthy()
    }
  })
})

describe('profile.get', () => {
  let sdk: MythworkClient

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('returns profile for a seed maker handle', async () => {
    const handle = SEED_MAKERS[0]!.handle
    const result = await sdk.profile.get({ handle })
    expect(result).toMatchObject({ exists: true, handle })
    if ('handle' in result) {
      expect(result.handle).toBe(handle)
    }
  })

  it('returns { exists:false } for unknown handle', async () => {
    const result = await sdk.profile.get({ handle: 'no-such-maker' })
    expect(result).toEqual({ exists: false })
  })
})

describe('unknown method', () => {
  it('responds with error (never hangs)', async () => {
    const sdk = makeClient()
    // @ts-expect-error testing unknown method
    await expect(sdk.request('explore.nonexistent', {})).rejects.toThrow('Unknown method')
    sdk.port.close()
  })
})

describe('notification prefs', () => {
  it('returns default prefs and allows update', async () => {
    const sdk = makeClient()
    const prefs = await sdk.profile.getNotificationPrefs()
    expect(typeof prefs.comments).toBe('boolean')
    expect(typeof prefs.remixes).toBe('boolean')
    const updated = await sdk.profile.setNotificationPrefs({ weeklyDigest: true })
    expect(updated.weeklyDigest).toBe(true)
    sdk.port.close()
  })
})

describe('profile.update read-after-write (fidelity)', () => {
  let sdk: MythworkClient

  beforeEach(async () => {
    sdk = makeClient()
    await sdk.auth.signIn()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('persists bio/location/link so profile.me reads exactly what was written', async () => {
    await sdk.profile.update({
      displayName: 'Ada L',
      bio: 'hi bio',
      location: 'NYC',
      link: 'ada.dev',
    })
    const me = await sdk.profile.me()
    expect(me).toMatchObject({
      displayName: 'Ada L',
      bio: 'hi bio',
      location: 'NYC',
      link: 'ada.dev',
    })
  })

  it('a partial update leaves untouched fields intact', async () => {
    await sdk.profile.update({ bio: 'first', location: 'SF', link: 'x.dev' })
    await sdk.profile.update({ bio: 'second' }) // only bio
    const me = await sdk.profile.me()
    expect(me).toMatchObject({ bio: 'second', location: 'SF', link: 'x.dev' })
  })
})

describe('explore.clearRating (signed-in happy path)', () => {
  it('clears a previously set rating', async () => {
    const sdk = makeClient()
    await sdk.auth.signIn()
    const projectId = SEED_APPS[0]!.projectId
    await sdk.explore.rate({ projectId, stars: 4 })
    const cleared = await sdk.explore.clearRating({ projectId })
    expect(cleared).toEqual({ ok: true })
    const ratings = await sdk.explore.myRatings()
    expect('ratings' in ratings).toBe(true)
    if ('ratings' in ratings) expect(ratings.ratings[projectId]).toBeUndefined()
    sdk.port.close()
  })
})

describe('kernel.signOut reverts identity', () => {
  it('getUser returns the anonymous sentinel after signOut', async () => {
    const sdk = makeClient()
    await sdk.auth.signIn()
    await sdk.auth.signOut()
    const user = await sdk.auth.getUser()
    expect(user).toEqual({ kind: 'anonymous', userId: 'anonymous' })
    sdk.port.close()
  })
})

describe('explore.addComment — reply shape + unknown parent', () => {
  let sdk: MythworkClient

  beforeEach(async () => {
    sdk = makeClient()
    await sdk.auth.signIn()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('a reply resolves to a CommentNode with empty replies', async () => {
    const projectId = 'app_dev_001'
    const { items } = await sdk.explore.comments({ projectId })
    const reply = await sdk.explore.addComment({
      projectId,
      body: 'a reply',
      parentCommentId: items[0]!.id,
    })
    expect('replies' in reply).toBe(true)
    if ('replies' in reply) expect(reply.replies).toEqual([])
  })

  it('a reply to an unknown parent returns { ok:false, reason:"not_found" }', async () => {
    const result = await sdk.explore.addComment({
      projectId: 'app_dev_001',
      body: 'orphan',
      parentCommentId: 'no-such-parent',
    })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('profile.setNotificationPrefs merges', () => {
  it('a partial update preserves untouched keys', async () => {
    const sdk = makeClient()
    const before = await sdk.profile.getNotificationPrefs()
    const updated = await sdk.profile.setNotificationPrefs({ weeklyDigest: !before.weeklyDigest })
    expect(updated.weeklyDigest).toBe(!before.weeklyDigest)
    expect(updated.comments).toBe(before.comments)
    expect(updated.remixes).toBe(before.remixes)
    sdk.port.close()
  })
})

describe('state isolation between dev hosts', () => {
  it('signing in on one client leaves another anonymous', async () => {
    const a = makeClient()
    const b = makeClient()
    await a.auth.signIn()
    const ua = await a.auth.getUser()
    const ub = await b.auth.getUser()
    expect(ua.kind).toBe('public')
    expect(ub).toEqual({ kind: 'anonymous', userId: 'anonymous' })
    a.port.close()
    b.port.close()
  })
})

describe('explore.updateAppMeta (owner app-meta override)', () => {
  let sdk: MythworkClient
  // SEED_MAKERS[0] ('devuser', the dev signed-in user) owns this app; another
  // maker owns the other.
  const ownApp = SEED_APPS.find(a => a.maker.handle === SEED_MAKERS[0]!.handle)!
  const otherApp = SEED_APPS.find(a => a.maker.handle !== SEED_MAKERS[0]!.handle)!

  beforeEach(() => {
    sdk = makeClient()
  })
  afterEach(() => {
    sdk.port.close()
  })

  it('signed-out returns { ok:false, reason:"sign_in_required" } (no throw)', async () => {
    const result = await sdk.explore.updateAppMeta({ projectId: ownApp.projectId, name: 'X' })
    expect(result).toEqual({ ok: false, reason: 'sign_in_required' })
  })

  it('owner edit returns the updated AppDetail and getApp reads it back', async () => {
    await sdk.auth.signIn()
    const updated = await sdk.explore.updateAppMeta({
      projectId: ownApp.projectId,
      name: 'Renamed App',
      tagline: 'A fresh tagline',
      note: 'why I built it',
    })
    expect(updated).toMatchObject({
      projectId: ownApp.projectId,
      name: 'Renamed App',
      tagline: 'A fresh tagline',
      makersNote: 'why I built it',
    })
    // Read-after-write: the override layers over the seed on the detail read.
    const detail = await sdk.explore.getApp({ projectId: ownApp.projectId })
    expect(detail).toMatchObject({
      name: 'Renamed App',
      tagline: 'A fresh tagline',
      makersNote: 'why I built it',
    })
  })

  it('a partial update preserves previously-set fields', async () => {
    await sdk.auth.signIn()
    await sdk.explore.updateAppMeta({
      projectId: ownApp.projectId,
      name: 'First',
      tagline: 'Keep me',
    })
    await sdk.explore.updateAppMeta({ projectId: ownApp.projectId, name: 'Second' })
    const detail = await sdk.explore.getApp({ projectId: ownApp.projectId })
    expect(detail).toMatchObject({ name: 'Second', tagline: 'Keep me' })
  })

  it('a non-owner edit returns { ok:false, reason:"forbidden" }', async () => {
    await sdk.auth.signIn()
    const result = await sdk.explore.updateAppMeta({ projectId: otherApp.projectId, name: 'X' })
    expect(result).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('an unknown app returns { ok:false, reason:"not_found" }', async () => {
    await sdk.auth.signIn()
    const result = await sdk.explore.updateAppMeta({ projectId: 'no-such-app', name: 'X' })
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('dev host: noProfile onboarding flow', () => {
  let sdk: MythworkClient

  afterEach(() => {
    sdk.port.close()
  })

  it('noProfile signIn → profile.me is { ok:false, reason:"no_profile" }', async () => {
    sdk = await connect({ dev: { noProfile: true } })
    expect(sdk).toBeInstanceOf(MythworkClient)
    await sdk.auth.signIn()
    const me = await sdk.profile.me()
    expect(me).toEqual({ ok: false, reason: 'no_profile' })
  })

  it('claimHandle succeeds and profile.me then resolves with the claimed handle', async () => {
    sdk = await connect({ dev: { noProfile: true } })
    const user = await sdk.auth.signIn()
    const r = await sdk.profile.claimHandle({ handle: 'ada' })
    // Success shape: NOT a { ok:false } failure.
    expect('ok' in r === false || r.ok !== false).toBe(true)
    expect(r).toMatchObject({ handle: 'ada', ownerUserId: user.userId })
    const me = await sdk.profile.me()
    expect(me).toMatchObject({ handle: 'ada', isOwner: true })
    expect('reason' in me).toBe(false)
  })

  it('claiming a seed maker handle owned by someone else → handle_taken; profile.me stays no_profile', async () => {
    sdk = await connect({ dev: { noProfile: true } })
    await sdk.auth.signIn()
    const r = await sdk.profile.claimHandle({ handle: SEED_MAKERS[0]!.handle })
    expect(r).toEqual({ ok: false, reason: 'handle_taken' })
    const me = await sdk.profile.me()
    expect(me).toEqual({ ok: false, reason: 'no_profile' })
  })

  it('signed-out claimHandle rejects (throws sign in required)', async () => {
    sdk = makeClient()
    await expect(sdk.profile.claimHandle({ handle: 'x' })).rejects.toThrow(/sign in/i)
  })

  it('claim persists across profile.update', async () => {
    sdk = await connect({ dev: { noProfile: true } })
    await sdk.auth.signIn()
    await sdk.profile.claimHandle({ handle: 'ada' })
    await sdk.profile.update({ displayName: 'Ada' })
    const me = await sdk.profile.me()
    expect(me).toMatchObject({ handle: 'ada', displayName: 'Ada', isOwner: true })
  })

  it('signOut clears the claim → profile.me is no_profile again on the next signIn', async () => {
    sdk = await connect({ dev: { noProfile: true } })
    await sdk.auth.signIn()
    await sdk.profile.claimHandle({ handle: 'ada' })
    await sdk.auth.signOut()
    await sdk.auth.signIn()
    const me = await sdk.profile.me()
    expect(me).toEqual({ ok: false, reason: 'no_profile' })
  })

  it('default mode (dev:true) is unchanged: signIn → profile.me returns a seed profile', async () => {
    sdk = await connect({ dev: true })
    await sdk.auth.signIn()
    const me = await sdk.profile.me()
    expect('reason' in me).toBe(false)
    expect(me).toMatchObject({ isOwner: true })
  })
})

describe('explore.updateAppMeta — override reflects across all reads (no card↔detail divergence)', () => {
  it("an owner's rename shows in cards/lists/search, not only on the detail page", async () => {
    const sdk = makeClient()
    await sdk.auth.signIn()
    const ownApp = SEED_APPS.find(a => a.maker.handle === SEED_MAKERS[0]!.handle)!
    await sdk.explore.updateAppMeta({ projectId: ownApp.projectId, name: 'Edited Name' })

    // detail
    const detail = await sdk.explore.getApp({ projectId: ownApp.projectId })
    expect(detail.name).toBe('Edited Name')
    // listApps card
    const { items } = await sdk.explore.listApps()
    expect(items.find(a => a.projectId === ownApp.projectId)?.name).toBe('Edited Name')
    // search finds the edited name (override applied before scoring)
    const { apps } = await sdk.explore.search({ q: 'Edited' })
    expect(apps.find(a => a.projectId === ownApp.projectId)?.name).toBe('Edited Name')

    sdk.port.close()
  })
})
