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
    // Draft explore surface (not yet served by deployed hosts).
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
