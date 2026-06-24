// Integration tests for the dev host's EDITOR surface (project/fs/git/collab),
// driven over a real MythworkClient. Covers a single-client round-trip and the
// cross-client sharing (shared commit log + fs.changed pushes) that an editor
// app's multiplayer needs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connect } from '../index'
import { MythworkClient } from '../client'
import { _resetDevHostForTests, createDevHost } from './host'

const enc = new TextEncoder()
const dec = new TextDecoder()
const tick = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => _resetDevHostForTests())

describe('dev host — single-client project/fs/git', () => {
  let sdk: MythworkClient
  beforeEach(() => {
    sdk = new MythworkClient(createDevHost())
  })
  afterEach(() => sdk.port.close())

  it('create → write → read → list → exists', async () => {
    const { pid, role } = await sdk.project.create({ projectName: 'demo' })
    expect(role).toBe('leader')
    await sdk.fs.write({ pid, path: '/index.html', bytes: enc.encode('<h1>v1</h1>') })
    expect(dec.decode(await sdk.fs.read({ pid, path: '/index.html' }))).toBe('<h1>v1</h1>')
    expect(await sdk.fs.list({ pid })).toEqual(['/index.html'])
    expect((await sdk.fs.exists({ pid, path: '/index.html' })).exists).toBe(true)
    expect((await sdk.fs.exists({ pid, path: '/missing' })).exists).toBe(false)
  })

  it('commit → log → head, and showVersion returns the historical snapshot', async () => {
    const { pid } = await sdk.project.create({})
    await sdk.fs.write({ pid, path: '/index.html', bytes: enc.encode('<h1>v1</h1>') })
    const { sha: sha1 } = await sdk.git.commit({
      pid,
      message: 'shot 1 · serve',
      author: { name: 'Ada', email: 'ada@orbit' },
    })
    expect(await sdk.git.head({ pid })).toBe(sha1)

    // mutate + commit again; the old sha still resolves to v1.
    await sdk.fs.write({ pid, path: '/index.html', bytes: enc.encode('<h1>v2</h1>') })
    const { sha: sha2 } = await sdk.git.commit({
      pid,
      message: 'shot 2',
      author: { name: 'B', email: 'b@orbit' },
    })

    const log = await sdk.git.log({ pid })
    expect(log.map(c => c.sha)).toEqual([sha2, sha1]) // newest first
    expect(log[1]!.authorEmail).toBe('ada@orbit')
    expect(dec.decode(await sdk.git.showVersion({ pid, shaLike: sha1, path: '/index.html' }))).toBe(
      '<h1>v1</h1>',
    )
    expect(
      dec.decode(await sdk.git.showVersion({ pid, shaLike: 'HEAD', path: '/index.html' })),
    ).toBe('<h1>v2</h1>')
  })

  it('getNames returns stored project names; list + getNames round-trip', async () => {
    const { pid: p1 } = await sdk.project.create({ projectName: 'first app' })
    const { pid: p2 } = await sdk.project.create({}) // no name → defaults to pid
    const { pids } = await sdk.project.list({})
    expect(pids).toEqual(expect.arrayContaining([p1, p2]))
    const { names } = await sdk.project.getNames({ pids: [p1, p2, 'unknown-pid'] })
    expect(names[p1]).toBe('first app')
    expect(names[p2]).toBe(p2) // create({}) defaults the name to the pid
    expect(names['unknown-pid']).toBeNull() // unknown pid → null
  })
})

describe('dev host — two clients share one project', () => {
  it('follower sees leader commits + receives cross-client fs.changed', async () => {
    const a = new MythworkClient(createDevHost())
    const b = new MythworkClient(createDevHost())
    const { pid } = await a.project.create({ projectName: 'match' })
    const { role } = await b.project.open({ pid })
    expect(role).toBe('follower')

    // A subscribes; B writes + commits → A is notified and sees shared state.
    const seen: string[] = []
    a.fs.onChanged(({ path }) => seen.push(path))

    await b.fs.write({ pid, path: '/index.html', bytes: enc.encode('hi from B') })
    await b.git.commit({ pid, message: 'shot 1', author: { name: 'B', email: 'b@orbit' } })
    await tick()

    expect(seen).toContain('/index.html') // the write push reached A
    const log = await a.git.log({ pid })
    expect(log).toHaveLength(1)
    expect(log[0]!.message).toBe('shot 1')
    expect(dec.decode(await a.fs.read({ pid, path: '/index.html' }))).toBe('hi from B')

    a.port.close()
    b.port.close()
  })

  it('a writer does not receive its own fs.changed', async () => {
    const a = new MythworkClient(createDevHost())
    const { pid } = await a.project.create({})
    const own: string[] = []
    a.fs.onChanged(({ path }) => own.push(path))
    await a.fs.write({ pid, path: '/x', bytes: enc.encode('x') })
    await tick()
    expect(own).toEqual([]) // origin is excluded
    a.port.close()
  })
})

describe('connect({ dev: true }) — editor surface', () => {
  it('exposes project + collab.openRoom with a shared dev room id', async () => {
    const sdk = await connect({ dev: true })
    const { pid } = await sdk.project.create({ projectName: 'm' })
    const room = await sdk.collab.openRoom({ pid, name: 'index.html' })
    expect(room.roomId).toBe(`dev:${pid}:project:index.html`)
    expect(room.serverUrl).toBe('dev:relay')
  })
})
