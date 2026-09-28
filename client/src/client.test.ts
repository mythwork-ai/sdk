import {
  DEFAULT_INTERACTIVE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  JOB_REQUEST_DEFAULT_TIMEOUT_MS,
  JOB_REQUEST_MAX_TIMEOUT_MS,
  JOB_REQUEST_REPLY_MARGIN_MS,
  OC_SIGNIN_GESTURE,
} from '@mythwork/protocol'
import type { Id } from '@mythwork/protocol/contract/db-client.interface'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MythworkClient } from './client'

// Wire-mapping tests: a namespaced helper must emit the deployed (sometimes
// legacy) wire method string with the params passed straight through. We watch
// the "host" side of the channel to capture what actually went over the wire,
// then reply so the helper promise settles.

describe('namespaced helper → wire method mapping', () => {
  let chan: MessageChannel
  let client: MythworkClient
  let outbound: { id: string; method: string; args: Record<string, unknown> }[]

  beforeEach(() => {
    chan = new MessageChannel()
    outbound = []
    chan.port2.start()
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string; method: string; args: Record<string, unknown> }
      outbound.push(d)
      // Auto-ack so the helper's promise resolves.
      chan.port2.postMessage({ id: d.id, result: { ok: true } })
    })
    client = new MythworkClient(chan.port1)
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })

  const cases: [string, () => Promise<unknown>, string, Record<string, unknown>][] = [
    ['auth.getUser', () => client.auth.getUser(), 'kernel.getUser', {}],
    ['auth.signIn', () => client.auth.signIn(), 'kernel.signIn', {}],
    ['auth.signOut', () => client.auth.signOut(), 'kernel.signOut', {}],
    ['auth.platformSignOut', () => client.auth.platformSignOut(), 'kernel.platformSignOut', {}],
    ['git.log', () => client.git.log({ pid: 'p', depth: 5 }), 'fs.log', { pid: 'p', depth: 5 }],
    [
      'git.commit',
      () => client.git.commit({ pid: 'p', message: 'm' }),
      'fs.commit',
      { pid: 'p', message: 'm' },
    ],
    [
      'project.publish',
      () => client.project.publish({ pid: 'p', shortName: 'x' }),
      'publish.run',
      { pid: 'p', shortName: 'x' },
    ],
    ['fs.read', () => client.fs.read({ pid: 'p', path: 'a' }), 'fs.read', { pid: 'p', path: 'a' }],
    [
      'collab.openRoom',
      () => client.collab.openRoom({ pid: 'p', name: 'r' }),
      'collab.openRoom',
      { pid: 'p', name: 'r' },
    ],
    ['config.get', () => client.config.get({ pid: 'p' }), 'config.get', { pid: 'p' }],
    [
      'ydocs.getAll',
      () => client.ydocs.getAll({ pid: 'p', docName: 'd' }),
      'ydocs.getAll',
      { pid: 'p', docName: 'd' },
    ],
    ['profile.get', () => client.profile.get({ handle: 'h' }), 'profile.get', { handle: 'h' }],
    [
      'nav.reportLocation',
      () => client.nav.reportLocation({ path: '/showcase' }),
      'nav.reportLocation',
      { path: '/showcase' },
    ],
    // explore surface wire-routing (project.remix below is still draft).
    [
      'explore.listApps',
      () => client.explore.listApps({ tags: ['game'], sort: 'new' }),
      'explore.listApps',
      { tags: ['game'], sort: 'new' },
    ],
    [
      'explore.getApp',
      () => client.explore.getApp({ projectId: 'pid1' }),
      'explore.getApp',
      { projectId: 'pid1' },
    ],
    [
      'explore.addComment',
      () => client.explore.addComment({ projectId: 'pid1', body: 'hi' }),
      'explore.addComment',
      { projectId: 'pid1', body: 'hi' },
    ],
    [
      'project.remix',
      () => client.project.remix({ projectId: 'pid1' }),
      'project.remix',
      { projectId: 'pid1' },
    ],
    [
      'project.getDescription',
      () => client.project.getDescription({ pid: 'p' }),
      'project.getDescription',
      { pid: 'p' },
    ],
    [
      'project.setDescription',
      () => client.project.setDescription({ pid: 'p', description: 'd' }),
      'project.setDescription',
      { pid: 'p', description: 'd' },
    ],
    [
      'build.applyTheme',
      () =>
        client.build.applyTheme({
          sessionId: 'sess_1',
          theme: { style: 'retro', hue: 200, mode: 'dark' },
        }),
      'build.applyTheme',
      { sessionId: 'sess_1', theme: { style: 'retro', hue: 200, mode: 'dark' } },
    ],
    [
      'build.setTitle',
      () => client.build.setTitle({ sessionId: 'sess_1', name: 'Renamed' }),
      'build.setTitle',
      { sessionId: 'sess_1', name: 'Renamed' },
    ],
    [
      'build.request',
      () =>
        client.build.request({
          sessionId: 'sess_1',
          type: 'history/restore',
          method: 'PUT',
          query: { limit: '20' },
          body: { checkpoint: 'c1' },
          timeoutMs: 60_000,
        }),
      'build.request',
      {
        sessionId: 'sess_1',
        type: 'history/restore',
        method: 'PUT',
        query: { limit: '20' },
        body: { checkpoint: 'c1' },
        timeoutMs: 60_000,
      },
    ],
    ['profile.me', () => client.profile.me(), 'profile.me', {}],
    [
      'profile.myFavorites',
      () => client.profile.myFavorites({ targetKind: 'app' }),
      'profile.myFavorites',
      { targetKind: 'app' },
    ],
    [
      'profile.setNotificationPrefs',
      () => client.profile.setNotificationPrefs({ comments: false }),
      'profile.setNotificationPrefs',
      { comments: false },
    ],
    [
      'notifications.list',
      () => client.notifications.list({ limit: 10 }),
      'notifications.list',
      { limit: 10 },
    ],
    [
      'notifications.listUnread',
      () => client.notifications.listUnread({ limit: 10 }),
      'notifications.listUnread',
      { limit: 10 },
    ],
    [
      'notifications.getUnreadCount',
      () => client.notifications.getUnreadCount(),
      'notifications.getUnreadCount',
      {},
    ],
    [
      'notifications.markRead',
      () => client.notifications.markRead({ id: 'n1' }),
      'notifications.markRead',
      { id: 'n1' },
    ],
    [
      'notifications.markUnread',
      () => client.notifications.markUnread({ id: 'n1' }),
      'notifications.markUnread',
      { id: 'n1' },
    ],
    [
      'profile.submitClaim',
      () =>
        client.profile.submitClaim({
          name: 'Eric',
          email: 'e@x.com',
          handle: 'eric',
          acceptedTerms: true,
        }),
      'profile.submitClaim',
      { name: 'Eric', email: 'e@x.com', handle: 'eric', acceptedTerms: true },
    ],
    [
      'event.sendBatch',
      () => client.event.sendBatch({ batch: [{ message: 'boom' }] }),
      'event.sendBatch',
      { batch: [{ message: 'boom' }] },
    ],
    [
      'profile.getAnalyticsConsent',
      () => client.profile.getAnalyticsConsent(),
      'profile.getAnalyticsConsent',
      {},
    ],
    [
      'profile.setAnalyticsConsent',
      () => client.profile.setAnalyticsConsent({ analytics: 'granted' }),
      'profile.setAnalyticsConsent',
      { analytics: 'granted' },
    ],
    ['env.list', () => client.env.list(), 'env.list', {}],
    ['env.open', () => client.env.open(), 'env.open', {}],
    [
      'db.list',
      () => client.db.list('task', { where: { done: false } }),
      'database.list',
      { entity: 'task', where: { done: false } },
    ],
    [
      'db.get',
      () => client.db.get('task', 42 as Id<string>),
      'database.get',
      { entity: 'task', id: 42 },
    ],
    [
      'db.count',
      () => client.db.count('task', { done: false }),
      'database.count',
      { entity: 'task', where: { done: false } },
    ],
    [
      'db.create',
      () => client.db.create('task', { title: 'write tests' }),
      'database.create',
      { entity: 'task', body: { title: 'write tests' } },
    ],
    [
      'db.update',
      () => client.db.update('task', 42 as Id<string>, { done: true }),
      'database.update',
      { entity: 'task', id: 42, patch: { done: true } },
    ],
    [
      'db.delete',
      () => client.db.delete('task', 42 as Id<string>),
      'database.delete',
      { entity: 'task', id: 42 },
    ],
    ['db.schema', () => client.db.schema(), 'database.schema', {}],
  ]

  for (const [label, invoke, wireMethod, wireArgs] of cases) {
    it(`${label} sends '${wireMethod}' with params passed through`, async () => {
      await invoke()
      expect(outbound).toHaveLength(1)
      expect(outbound[0]!.method).toBe(wireMethod)
      expect(outbound[0]!.args).toEqual(wireArgs)
    })
  }
})

// Regression coverage for the primary browser-fleet-reported bug (root cause
// #1): `auth.signIn`/`auth.signOut` must actually apply
// `DEFAULT_INTERACTIVE_TIMEOUT_MS` (120s), not silently fall back to
// `requestOverPort`'s generic `DEFAULT_REQUEST_TIMEOUT_MS` (30s) — the mismatch
// that let the client give up on `kernel.signIn` before a human-paced OAuth
// popup (host-iframe's `signInWithPopup`, up to 90s) had a realistic chance to
// finish. Every existing test above replies before either timer fires, so none
// of them would notice a regression that dropped the override in `client.ts`
// (verified: reverting that line still left the full suite green).
describe('auth.signIn / auth.signOut interactive-timeout budget', () => {
  let chan: MessageChannel
  let client: MythworkClient

  beforeEach(() => {
    chan = new MessageChannel()
    chan.port2.start()
    // The host never replies — these tests only care about when (if) the
    // client gives up on its own.
    client = new MythworkClient(chan.port1)
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
    vi.useRealTimers()
  })

  it('auth.signIn does not time out at the generic 30s default', async () => {
    vi.useFakeTimers()
    const p = client.auth.signIn()
    const settled = vi.fn()
    p.catch(settled)

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    // Still pending 30s in — the 30s generic default must not have fired.
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERACTIVE_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS)
    await expect(p).rejects.toThrow(/timed out after 120000ms/)
  })

  it('project.open does not time out at the generic 30s default', async () => {
    // An open materializes the project's tree when this device does not hold
    // it — a serial walk, one request per object. The generic budget would
    // fail the caller mid-walk while the host kept working.
    vi.useFakeTimers()
    const p = client.project.open({ pid: 'p-open-1234567' })
    const settled = vi.fn()
    p.catch(settled)

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERACTIVE_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS)
    await expect(p).rejects.toThrow(/timed out after 120000ms/)
  })

  it('project.open honors an explicit timeout override, and a present-but-unset one falls back', async () => {
    vi.useFakeTimers()
    const explicit = client.project.open({ pid: 'p-open-1234567' }, { timeoutMs: 5000 })
    const explicitAssertion = expect(explicit).rejects.toThrow(/timed out after 5000ms/)
    await vi.advanceTimersByTimeAsync(5000)
    await explicitAssertion

    const spread = client.project.open({ pid: 'p-open-7654321' }, { timeoutMs: undefined })
    const spreadAssertion = expect(spread).rejects.toThrow(/timed out after 120000ms/)
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERACTIVE_TIMEOUT_MS)
    await spreadAssertion
  })

  it.each([
    ['project.publish', () => client.project.publish({ pid: 'p-pub-1234567', shortName: 'x' })],
    ['profile.publish', () => client.profile.publish({ pid: 'p-pub-1234567', handle: 'h' })],
  ])('%s does not time out at the generic 30s default', async (_name, call) => {
    vi.useFakeTimers()
    const p = call()
    const settled = vi.fn()
    p.catch(settled)

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERACTIVE_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS)
    await expect(p).rejects.toThrow(/timed out after 120000ms/)
  })

  it('project.publish honors an explicit timeout override', async () => {
    vi.useFakeTimers()
    const p = client.project.publish({ pid: 'p-pub-1234567', shortName: 'x' }, { timeoutMs: 5000 })
    const assertion = expect(p).rejects.toThrow(/timed out after 5000ms/)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  it('project.close still uses the generic 30s default', async () => {
    vi.useFakeTimers()
    const p = client.project.close({ pid: 'p-close-1234567' })
    const assertion = expect(p).rejects.toThrow(/timed out after 30000ms/)
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    await assertion
  })

  it('auth.signOut uses the generic 30s default, not the 120s interactive budget', async () => {
    vi.useFakeTimers()
    const p = client.auth.signOut()
    const assertion = expect(p).rejects.toThrow(/timed out after 30000ms/)
    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    await assertion
  })

  it('auth.signIn honors an explicit opts.timeoutMs override over the interactive default', async () => {
    vi.useFakeTimers()
    const p = client.auth.signIn({}, { timeoutMs: 5000 })
    const assertion = expect(p).rejects.toThrow(/timed out after 5000ms/)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  // Regression for the override-pattern bug caught in review: `{ ...opts,
  // timeoutMs: opts?.timeoutMs ?? DEFAULT }` must fall back to the 120s
  // interactive default even when the caller's `opts` object has `timeoutMs`
  // present-but-`undefined` (e.g. a wrapper spreading a shared options bag
  // with an optional field left unset) — not just when the key is absent
  // entirely. The buggy `{ timeoutMs: DEFAULT, ...opts }` order (object-spread
  // `undefined` winning over the literal default) passes every other test in
  // this file but fails this one: it falls through to `requestOverPort`'s own
  // `opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS` and times out at 30s.
  it('auth.signIn still applies the 120s interactive default when opts.timeoutMs is explicitly undefined', async () => {
    vi.useFakeTimers()
    const p = client.auth.signIn({}, { timeoutMs: undefined })
    const settled = vi.fn()
    p.catch(settled)

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    // Must still be pending at 30s — the generic default must not have fired
    // just because `timeoutMs` was present-but-unset on the passed opts.
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DEFAULT_INTERACTIVE_TIMEOUT_MS - DEFAULT_REQUEST_TIMEOUT_MS)
    await expect(p).rejects.toThrow(/timed out after 120000ms/)
  })
})

// A `build.request` may be HELD by its route for up to five minutes. The host's
// own deadline has to be the one that decides it, because that produces a
// RESULT (`{ ok: false, reason: 'timeout' }`) the caller can act on; the
// transport's produces a thrown error and a cancel. So the transport deadline
// tracks `timeoutMs` plus a margin instead of the generic 30s default.
describe('build.request transport budget', () => {
  let chan: MessageChannel
  let client: MythworkClient

  beforeEach(() => {
    chan = new MessageChannel()
    chan.port2.start()
    // The host never replies: these only care about when the client gives up.
    client = new MythworkClient(chan.port1)
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
    vi.useRealTimers()
  })

  const held = (opts?: { timeoutMs?: number }) =>
    client.build.request(
      { sessionId: 'sess_1', type: 'name', timeoutMs: JOB_REQUEST_MAX_TIMEOUT_MS },
      opts,
    )

  it('waits out a held request instead of cancelling it at the generic 30s default', async () => {
    vi.useFakeTimers()
    const p = held()
    const settled = vi.fn()
    p.catch(settled)

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(settled).not.toHaveBeenCalled()

    const budget = JOB_REQUEST_MAX_TIMEOUT_MS + JOB_REQUEST_REPLY_MARGIN_MS
    await vi.advanceTimersByTimeAsync(budget - DEFAULT_REQUEST_TIMEOUT_MS)
    await expect(p).rejects.toThrow(new RegExp(`timed out after ${budget}ms`))
  })

  it('uses the 30s default wait plus the margin when the caller names no timeout', async () => {
    vi.useFakeTimers()
    const p = client.build.request({ sessionId: 'sess_1', type: 'style-groups' })
    const budget = JOB_REQUEST_DEFAULT_TIMEOUT_MS + JOB_REQUEST_REPLY_MARGIN_MS
    const assertion = expect(p).rejects.toThrow(new RegExp(`timed out after ${budget}ms`))
    await vi.advanceTimersByTimeAsync(budget)
    await assertion
  })

  // The same present-but-undefined trap `auth.signIn` was caught by: a wrapper
  // spreading an options bag with `timeoutMs` left unset must still get the
  // budget, not fall through to the transport's generic default.
  it('still raises the budget when opts.timeoutMs is explicitly undefined', async () => {
    vi.useFakeTimers()
    const p = held({ timeoutMs: undefined })
    const settled = vi.fn()
    p.catch(settled)

    await vi.advanceTimersByTimeAsync(DEFAULT_REQUEST_TIMEOUT_MS)
    expect(settled).not.toHaveBeenCalled()

    const budget = JOB_REQUEST_MAX_TIMEOUT_MS + JOB_REQUEST_REPLY_MARGIN_MS
    await vi.advanceTimersByTimeAsync(budget - DEFAULT_REQUEST_TIMEOUT_MS)
    await expect(p).rejects.toThrow(new RegExp(`timed out after ${budget}ms`))
  })

  it('honours an explicit opts.timeoutMs over the computed budget', async () => {
    vi.useFakeTimers()
    const p = held({ timeoutMs: 5000 })
    const assertion = expect(p).rejects.toThrow(/timed out after 5000ms/)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })
})

describe('draft explore result passthrough', () => {
  let chan: MessageChannel
  let client: MythworkClient
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })

  it('explore.getApp returns the host AppDetail verbatim', async () => {
    chan = new MessageChannel()
    chan.port2.start()
    const detail = {
      projectId: 'pid1',
      alias: 'cool-app',
      name: 'Cool App',
      tagline: 'a tagline',
      maker: { handle: 'maker', displayName: 'Maker' },
      tags: ['game'],
      launches: 42,
      publishedAt: 1_700_000_000_000,
      editorsChoice: true,
      rating: { average: 4.5, count: 10 },
      makersNote: 'enjoy',
      remixCount: 3,
    }
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string }
      chan.port2.postMessage({ id: d.id, result: detail })
    })
    client = new MythworkClient(chan.port1)
    const result = await client.explore.getApp({ projectId: 'pid1' })
    expect(result).toEqual(detail)
    expect(result.remixCount).toBe(3)
    expect(result.maker.handle).toBe('maker')
  })
})

describe('profile.me three-state contract (0.2.0)', () => {
  let chan: MessageChannel
  let client: MythworkClient
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })

  /** Wire a host that answers profile.me with `result`. */
  function hostReturning(result: unknown): MythworkClient {
    chan = new MessageChannel()
    chan.port2.start()
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string; method: string }
      expect(d.method).toBe('profile.me')
      chan.port2.postMessage({ id: d.id, result })
    })
    client = new MythworkClient(chan.port1)
    return client
  }

  it('success narrows to the profile branch with handle + isOwner:true guaranteed', async () => {
    const profile = {
      handle: 'myhandle',
      isOwner: true,
      displayName: 'Me M',
      bio: 'hi',
      apps: [],
    }
    const res = await hostReturning(profile).profile.me()
    // The documented discriminant: failures carry `reason`, successes never do.
    if ('reason' in res) throw new Error('expected the success branch')
    // Inside the narrowed branch both guaranteed keys are typed, not optional:
    // `handle` is string, `isOwner` is the literal true.
    const handle: string = res.handle
    const isOwner: true = res.isOwner
    expect(handle).toBe('myhandle')
    expect(isOwner).toBe(true)
    expect(res).toEqual(profile)
  })

  it('signed-out resolves the gated result { ok:false, reason:sign_in_required }', async () => {
    const res = await hostReturning({ ok: false, reason: 'sign_in_required' }).profile.me()
    if (!('reason' in res)) throw new Error('expected the gated branch')
    expect(res).toEqual({ ok: false, reason: 'sign_in_required' })
  })

  it('unclaimed resolves { ok:false, reason:no_profile } (claim-first affordance)', async () => {
    const res = await hostReturning({ ok: false, reason: 'no_profile' }).profile.me()
    if (!('reason' in res)) throw new Error('expected the gated branch')
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('no_profile')
  })
})

describe('ai namespace (mythwork-ai proxy)', () => {
  let chan: MessageChannel
  let client: MythworkClient
  let outbound: { id: string; method: string; args: Record<string, unknown> }[]

  /** A normalized completion the host returns for ai.chat / ai.complete. */
  const completion = {
    id: 'cmpl-1',
    object: 'chat.completion' as const,
    created: 1,
    model: 'claude-opus-4-8',
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content: 'hi there' },
        finish_reason: 'stop',
      },
    ],
  }

  beforeEach(() => {
    chan = new MessageChannel()
    outbound = []
    chan.port2.start()
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string; method: string; args: Record<string, unknown> }
      outbound.push(d)
      if (d.args?.stream) {
        chan.port2.postMessage({ type: 'ai.delta', requestId: d.id, delta: 'hello ' })
        chan.port2.postMessage({ type: 'ai.delta', requestId: d.id, delta: 'world' })
      }
      chan.port2.postMessage({ id: d.id, result: completion })
    })
    client = new MythworkClient(chan.port1)
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })

  it('ai.chat sends ai.chat with the messages and returns the assistant message', async () => {
    const msg = await client.ai.chat([{ role: 'user', content: 'hi' }])
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.method).toBe('ai.chat')
    expect(outbound[0]!.args).toEqual({ messages: [{ role: 'user', content: 'hi' }] })
    expect(msg).toEqual({ role: 'assistant', content: 'hi there' })
  })

  it('ai.chat maps camelCase opts onto the snake_case wire params', async () => {
    await client.ai.chat([{ role: 'user', content: 'hi' }], {
      model: 'claude-opus-4-8',
      system: 'be terse',
      maxTokens: 256,
      temperature: 0.2,
      topP: 0.9,
      tools: [{ type: 'function' }],
      toolChoice: 'auto',
      thinking: true,
    })
    expect(outbound[0]!.args).toEqual({
      messages: [{ role: 'user', content: 'hi' }],
      model: 'claude-opus-4-8',
      system: 'be terse',
      max_tokens: 256,
      temperature: 0.2,
      top_p: 0.9,
      tools: [{ type: 'function' }],
      tool_choice: 'auto',
      thinking: true,
    })
  })

  it('ai.complete sends ai.complete with the prompt and returns the assistant text', async () => {
    const text = await client.ai.complete('write a haiku')
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.method).toBe('ai.complete')
    expect(outbound[0]!.args).toEqual({ prompt: 'write a haiku' })
    expect(text).toBe('hi there')
  })

  it('ai.complete maps camelCase opts onto the snake_case wire params', async () => {
    await client.ai.complete('hi', { system: 'be terse', maxTokens: 64 })
    expect(outbound[0]!.args).toEqual({ prompt: 'hi', system: 'be terse', max_tokens: 64 })
  })

  it('ai.complete with onChunk streams deltas and resolves the assistant text', async () => {
    const chunks: string[] = []
    const text = await client.ai.complete('write a haiku', { onChunk: d => chunks.push(d) })
    expect(chunks).toEqual(['hello ', 'world'])
    expect(text).toBe('hi there')
  })

  it('ai.complete with onChunk sends stream:true in outbound args', async () => {
    await client.ai.complete('x', { onChunk: () => {} })
    expect(outbound[0]!.args.stream).toBe(true)
  })

  it('ai.complete without onChunk does NOT send stream in outbound args (buffered path)', async () => {
    await client.ai.complete('x')
    expect(outbound[0]!.args).not.toHaveProperty('stream')
  })

  it('ai.chat with onChunk streams deltas and resolves the assistant ChatMessage', async () => {
    const chunks: string[] = []
    const msg = await client.ai.chat([{ role: 'user', content: 'hi' }], {
      onChunk: d => chunks.push(d),
    })
    expect(chunks).toEqual(['hello ', 'world'])
    expect(msg).toEqual({ role: 'assistant', content: 'hi there' })
  })

  it('ai.complete forwards systemPreset on the wire (never system, never projectId)', async () => {
    await client.ai.complete('hi', { systemPreset: 'project_plan' })
    expect(outbound[0]!.method).toBe('ai.complete')
    expect(outbound[0]!.args).toMatchObject({ prompt: 'hi', systemPreset: 'project_plan' })
    // Correction A: the client never sends a projectId; the host derives it.
    expect(outbound[0]!.args).not.toHaveProperty('projectId')
    // Mutually exclusive with system — only the preset name goes over the wire.
    expect(outbound[0]!.args).not.toHaveProperty('system')
  })

  it('ai.chat forwards systemPreset on the wire', async () => {
    await client.ai.chat([{ role: 'user', content: 'hi' }], { systemPreset: 'project_plan' })
    expect(outbound[0]!.args).toMatchObject({
      messages: [{ role: 'user', content: 'hi' }],
      systemPreset: 'project_plan',
    })
    expect(outbound[0]!.args).not.toHaveProperty('projectId')
  })
})

describe('prompts.list namespace', () => {
  let chan: MessageChannel
  let client: MythworkClient
  let outbound: { id: string; method: string; args: Record<string, unknown> }[]

  beforeEach(() => {
    chan = new MessageChannel()
    outbound = []
    chan.port2.start()
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string; method: string; args: Record<string, unknown> }
      outbound.push(d)
      chan.port2.postMessage({ id: d.id, result: { names: ['project_plan'] } })
    })
    client = new MythworkClient(chan.port1)
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })

  it('forwards to the prompts.list wire method with no client params', async () => {
    const res = await client.prompts.list()
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.method).toBe('prompts.list')
    // Correction A: no projectId — the host derives it from its trusted context.
    expect(outbound[0]!.args).toEqual({})
    expect(res).toEqual({ names: ['project_plan'] })
  })
})

describe('event helpers route to the right push prefix', () => {
  let chan: MessageChannel
  let client: MythworkClient
  beforeEach(() => {
    chan = new MessageChannel()
    chan.port2.start()
    client = new MythworkClient(chan.port1)
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })
  /**
   * Wait until `pred` holds, or fail after `timeoutMs` naming `label`.
   *
   * NOT a fixed sleep. `port2.postMessage` is delivered to `port1` by the
   * platform on its own schedule, and a single `setTimeout(0)` — one macrotask —
   * loses that race under a loaded CI runner: this block flaked in kernel-ci on
   * exactly that. Polling makes the wait as long as delivery actually takes
   * (one tick in the normal case) and turns a genuine non-delivery into a named
   * timeout instead of a bare length mismatch.
   */
  async function until(pred: () => boolean, label: string, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 0))
      if (pred()) return
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  it('fs.onChanged receives fs.changed pushes', async () => {
    const hits: unknown[] = []
    client.fs.onChanged(p => hits.push(p))
    chan.port2.postMessage({ type: 'fs.changed', pid: 'p', path: 'a', kind: 'updated' })
    await until(() => hits.length > 0, 'the fs.changed push')
    expect(hits).toHaveLength(1)
  })

  it('auth.onAuthChanged receives kernel.authChanged pushes', async () => {
    const hits: unknown[] = []
    client.auth.onAuthChanged(p => hits.push(p))
    chan.port2.postMessage({ type: 'kernel.authChanged', user: { kind: 'anonymous', userId: 'a' } })
    await until(() => hits.length > 0, 'the kernel.authChanged push')
    expect(hits).toHaveLength(1)
  })

  it('nav.onNavigate receives nav.navigate pushes', async () => {
    const hits: { path: string }[] = []
    client.nav.onNavigate(p => hits.push(p))
    chan.port2.postMessage({ type: 'nav.navigate', path: '/showcase' })
    await until(() => hits.length > 0, 'the nav.navigate push')
    expect(hits).toHaveLength(1)
    expect(hits[0]?.path).toBe('/showcase')
  })
})

describe('event.sendBatch never-rejects contract', () => {
  let chan: MessageChannel
  let client: MythworkClient
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })

  /** Wire a client whose "host" replies to every request with `reply(id)`. */
  function hostReplying(reply: ((id: string) => unknown) | null): MythworkClient {
    chan = new MessageChannel()
    chan.port2.start()
    if (reply) {
      chan.port2.addEventListener('message', e => {
        const d = e.data as { id: string }
        chan.port2.postMessage(reply(d.id))
      })
    }
    client = new MythworkClient(chan.port1)
    return client
  }

  it('resolves { ok: true } when the host rejects the request (pre-event-bridge routers)', async () => {
    // An already-deployed host whose router predates the `event.` prefix
    // rejects the RPC — the helper must swallow it, never blow up inside
    // the app's error handler.
    const c = hostReplying(id => ({ id, error: 'Unknown method: event.sendBatch' }))

    await expect(c.event.sendBatch({ batch: [{ message: 'boom' }] })).resolves.toEqual({
      ok: true,
    })
  })

  it('passes the sign-in refusal through unchanged', async () => {
    // A maker report filed from a signed-out browser is stored but shown to
    // nobody. The helper swallows transport failures, not this: an app that
    // reported it as "Sent" would be lying to the person who filed it.
    const c = hostReplying(id => ({
      id,
      result: { ok: true, forwarded: false, reason: 'sign_in_required' },
    }))

    await expect(
      c.event.sendBatch({ batch: [{ type: 'maker_report', text: 'it broke' }] }),
    ).resolves.toEqual({ ok: true, forwarded: false, reason: 'sign_in_required' })
  })

  it('passes the rate-limit refusal through unchanged', async () => {
    // The platform's per-address throttle dropped the batch before reading it,
    // so the report was never stored. Same rule as the sign-in refusal: the
    // helper must not flatten this into a plain success.
    const c = hostReplying(id => ({
      id,
      result: { ok: true, forwarded: false, reason: 'rate_limited' },
    }))

    await expect(
      c.event.sendBatch({ batch: [{ type: 'maker_report', text: 'it broke' }] }),
    ).resolves.toEqual({ ok: true, forwarded: false, reason: 'rate_limited' })
  })

  it('resolves { ok: true } on a timeout (host never replies)', async () => {
    const c = hostReplying(null)

    await expect(
      c.event.sendBatch({ batch: [{ message: 'boom' }] }, { timeoutMs: 1 }),
    ).resolves.toEqual({ ok: true })
  })

  it('propagates a DataCloneError from a non-cloneable batch item (programmer error)', async () => {
    // A function in an error payload can't cross postMessage — swallowing
    // this would leave telemetry silently dead forever, so it must throw.
    const c = hostReplying(id => ({ id, result: { ok: true } }))

    // Short timeoutMs: the sync postMessage throw settles the promise, but
    // the transport's already-armed timer isn't cleaned up on that path —
    // keep it from outliving the test.
    await expect(
      c.event.sendBatch({ batch: [{ callback: () => {} }] }, { timeoutMs: 50 }),
    ).rejects.toMatchObject({ name: 'DataCloneError' })
  })

  it('propagates an abort from a caller-supplied signal', async () => {
    const c = hostReplying(null)
    const controller = new AbortController()
    controller.abort()

    await expect(
      c.event.sendBatch({ batch: [] }, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('agent.create — the engine options ride through unchanged', () => {
  let chan: MessageChannel
  let client: MythworkClient
  let outbound: { id: string; method: string; args: Record<string, unknown> }[]

  beforeEach(() => {
    chan = new MessageChannel()
    outbound = []
    chan.port2.start()
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string; method: string; args: Record<string, unknown> }
      outbound.push(d)
      chan.port2.postMessage({ id: d.id, result: { sessionId: 'sess_1' } })
    })
    client = new MythworkClient(chan.port1)
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })

  it('sends the mythcode engine, its project and an attached job verbatim', async () => {
    const result = await client.agent.create({
      engine: 'mythcode',
      projectId: 'pTARGET',
      jobId: 'ptarget-lz3k9a1',
    })
    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.method).toBe('agent.create')
    expect(outbound[0]!.args).toEqual({
      engine: 'mythcode',
      projectId: 'pTARGET',
      jobId: 'ptarget-lz3k9a1',
    })
    expect(result).toEqual({ sessionId: 'sess_1' })
  })

  it('adds nothing of its own when no engine is named (the standard engine)', async () => {
    await client.agent.create({ persona: 'gaiad' })
    expect(outbound[0]!.args).toEqual({ persona: 'gaiad' })
  })

  it('returns a create-time refusal as a result, not a rejection', async () => {
    chan.port2.close()
    const chan2 = new MessageChannel()
    chan2.port2.start()
    chan2.port2.addEventListener('message', e => {
      const d = e.data as { id: string }
      chan2.port2.postMessage({ id: d.id, result: { ok: false, reason: 'engine_not_granted' } })
    })
    const c = new MythworkClient(chan2.port1)
    await expect(c.agent.create({ engine: 'mythcode', projectId: 'pTARGET' })).resolves.toEqual({
      ok: false,
      reason: 'engine_not_granted',
    })
    chan2.port1.close()
    chan2.port2.close()
  })
})

describe('sdk.db.for(projectId) — a named project rides through every call', () => {
  let chan: MessageChannel
  let client: MythworkClient
  let outbound: { id: string; method: string; args: Record<string, unknown> }[]

  beforeEach(() => {
    chan = new MessageChannel()
    outbound = []
    chan.port2.start()
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string; method: string; args: Record<string, unknown> }
      outbound.push(d)
      chan.port2.postMessage({ id: d.id, result: { ok: true } })
    })
    client = new MythworkClient(chan.port1)
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
  })

  it('the unbound sdk.db sends no projectId on any of the seven methods', async () => {
    await client.db.list('task', { where: { done: false } })
    await client.db.get('task', 42 as Id<string>)
    await client.db.count('task', { done: false })
    await client.db.create('task', { title: 'write tests' })
    await client.db.update('task', 42 as Id<string>, { done: true })
    await client.db.delete('task', 42 as Id<string>)
    await client.db.schema()

    expect(outbound).toHaveLength(7)
    for (const call of outbound) expect(call.args).not.toHaveProperty('projectId')
  })

  it('sdk.db.for(projectId) sends projectId on every one of the seven methods', async () => {
    const bound = client.db.for('pTARGET')
    await bound.list('task', { where: { done: false } })
    await bound.get('task', 42 as Id<string>)
    await bound.count('task', { done: false })
    await bound.create('task', { title: 'write tests' })
    await bound.update('task', 42 as Id<string>, { done: true })
    await bound.delete('task', 42 as Id<string>)
    await bound.schema()

    expect(outbound).toHaveLength(7)
    expect(outbound[0]).toMatchObject({
      method: 'database.list',
      args: { entity: 'task', where: { done: false }, projectId: 'pTARGET' },
    })
    expect(outbound[1]).toMatchObject({
      method: 'database.get',
      args: { entity: 'task', id: 42, projectId: 'pTARGET' },
    })
    expect(outbound[2]).toMatchObject({
      method: 'database.count',
      args: { entity: 'task', where: { done: false }, projectId: 'pTARGET' },
    })
    expect(outbound[3]).toMatchObject({
      method: 'database.create',
      args: { entity: 'task', body: { title: 'write tests' }, projectId: 'pTARGET' },
    })
    expect(outbound[4]).toMatchObject({
      method: 'database.update',
      args: { entity: 'task', id: 42, patch: { done: true }, projectId: 'pTARGET' },
    })
    expect(outbound[5]).toMatchObject({
      method: 'database.delete',
      args: { entity: 'task', id: 42, projectId: 'pTARGET' },
    })
    expect(outbound[6]).toMatchObject({
      method: 'database.schema',
      args: { projectId: 'pTARGET' },
    })
  })

  it('sdk.db.for(projectId, { jobId }) sends both ids on every one of the seven methods', async () => {
    const bound = client.db.for('P', { jobId: 'P-job9' })
    await bound.list('task', { where: { done: false } })
    await bound.get('task', 42 as Id<string>)
    await bound.count('task', { done: false })
    await bound.create('task', { title: 'write tests' })
    await bound.update('task', 42 as Id<string>, { done: true })
    await bound.delete('task', 42 as Id<string>)
    await bound.schema()

    expect(outbound).toHaveLength(7)
    expect(outbound[0]).toMatchObject({
      method: 'database.list',
      args: { entity: 'task', where: { done: false }, projectId: 'P', jobId: 'P-job9' },
    })
    expect(outbound[1]).toMatchObject({
      method: 'database.get',
      args: { entity: 'task', id: 42, projectId: 'P', jobId: 'P-job9' },
    })
    expect(outbound[2]).toMatchObject({
      method: 'database.count',
      args: { entity: 'task', where: { done: false }, projectId: 'P', jobId: 'P-job9' },
    })
    expect(outbound[3]).toMatchObject({
      method: 'database.create',
      args: { entity: 'task', body: { title: 'write tests' }, projectId: 'P', jobId: 'P-job9' },
    })
    expect(outbound[4]).toMatchObject({
      method: 'database.update',
      args: { entity: 'task', id: 42, patch: { done: true }, projectId: 'P', jobId: 'P-job9' },
    })
    expect(outbound[5]).toMatchObject({
      method: 'database.delete',
      args: { entity: 'task', id: 42, projectId: 'P', jobId: 'P-job9' },
    })
    expect(outbound[6]).toMatchObject({
      method: 'database.schema',
      args: { projectId: 'P', jobId: 'P-job9' },
    })
  })

  it('sdk.db.for(projectId) without options sends only projectId, never jobId', async () => {
    const bound = client.db.for('pTARGET')
    await bound.schema()

    expect(outbound).toHaveLength(1)
    expect(outbound[0]!.args).not.toHaveProperty('jobId')
  })
})

// The sign-in click has to reach the host's WINDOW, not just its port: WebKit
// carries a user gesture through `window.postMessage` and not through
// `MessagePort`, so this hint is the only thing that lets the host open the
// OAuth popup while Safari still credits the click. See OC_SIGNIN_GESTURE.
describe('auth.signIn gesture hint', () => {
  let chan: MessageChannel
  let client: MythworkClient
  let posted: { message: unknown; targetOrigin: string }[]
  const realWindow = globalThis.window

  beforeEach(() => {
    chan = new MessageChannel()
    chan.port2.start()
    chan.port2.addEventListener('message', e => {
      const d = e.data as { id: string }
      chan.port2.postMessage({ id: d.id, result: { kind: 'anonymous', userId: 'anonymous' } })
    })
    posted = []
    const parent = {
      postMessage: (message: unknown, targetOrigin: string) => {
        posted.push({ message, targetOrigin })
      },
    }
    vi.stubGlobal('window', { parent })
    client = new MythworkClient(chan.port1)
  })
  afterEach(() => {
    chan.port1.close()
    chan.port2.close()
    vi.stubGlobal('window', realWindow)
    vi.unstubAllGlobals()
  })

  it('posts the gesture to the host window before the RPC is sent', async () => {
    // Not awaited: the hint has to be out synchronously, in the click's own
    // call stack, or the gesture it exists to carry is already gone.
    const pending = client.auth.signIn()

    expect(posted).toEqual([{ message: { type: OC_SIGNIN_GESTURE }, targetOrigin: '*' }])
    await pending
  })

  it('sends no hint and still signs in when there is no host window', async () => {
    // Un-embedded callers (dev host, tests, node) have no parent to tell.
    vi.stubGlobal('window', undefined)
    const unembedded = new MythworkClient(chan.port1)

    await expect(unembedded.auth.signIn()).resolves.toMatchObject({ kind: 'anonymous' })
    expect(posted).toEqual([])
  })

  it('does not fail the sign-in when the parent refuses the post', async () => {
    vi.stubGlobal('window', {
      parent: {
        postMessage: () => {
          throw new Error('cross-origin refusal')
        },
      },
    })
    const refused = new MythworkClient(chan.port1)

    await expect(refused.auth.signIn()).resolves.toMatchObject({ kind: 'anonymous' })
  })
})
