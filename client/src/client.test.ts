import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
    ['git.log', () => client.git.log({ pid: 'p', depth: 5 }), 'fs.log', { pid: 'p', depth: 5 }],
    [
      'git.commit',
      () => client.git.commit({ pid: 'p', message: 'm' }),
      'fs.commit',
      { pid: 'p', message: 'm' },
    ],
    [
      'store.get',
      () => client.store.get({ store: 's', key: 'k' }),
      'db.get',
      { store: 's', key: 'k' },
    ],
    [
      'store.put',
      () => client.store.put({ store: 's', key: 'k', value: 1 }),
      'db.put',
      { store: 's', key: 'k', value: 1 },
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
  const flush = () => new Promise(r => setTimeout(r, 0))

  it('fs.onChanged receives fs.changed pushes', async () => {
    const hits: unknown[] = []
    client.fs.onChanged(p => hits.push(p))
    chan.port2.postMessage({ type: 'fs.changed', pid: 'p', path: 'a', kind: 'updated' })
    await flush()
    expect(hits).toHaveLength(1)
  })

  it('auth.onAuthChanged receives kernel.authChanged pushes', async () => {
    const hits: unknown[] = []
    client.auth.onAuthChanged(p => hits.push(p))
    chan.port2.postMessage({ type: 'kernel.authChanged', user: { kind: 'anonymous', userId: 'a' } })
    await flush()
    expect(hits).toHaveLength(1)
  })
})
