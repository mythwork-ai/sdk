// @vitest-environment happy-dom
//
// Contract tests for the project-scoped wrapper hooks (useUser / useFiles /
// useGit): each one maps its public surface to the right SDK wire methods,
// scoped to the project's pid, against a fake host over the real transport.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MythworkClient } from '../client'
import { MythworkProjectProvider, MythworkProvider, useFiles, useGit, useUser } from './index'

interface HostState {
  files: Record<string, Uint8Array>
  log: { sha: string; message: string; author: string; authorEmail: string; timestamp: Date }[]
  calls: { method: string; args: Record<string, unknown> }[]
  user: { kind: string; userId: string; displayName?: string; picture?: string }
}

function makeHost(initial?: Partial<HostState>): { client: MythworkClient; state: HostState } {
  const state: HostState = {
    files: initial?.files ?? {},
    log: initial?.log ?? [],
    calls: [],
    user: initial?.user ?? { kind: 'anonymous', userId: 'anon' },
  }
  const chan = new MessageChannel()
  chan.port2.start()
  chan.port2.onmessage = (e: MessageEvent) => {
    const { id, method, args } = e.data as {
      id: string
      method: string
      args: Record<string, unknown>
    }
    state.calls.push({ method, args })
    const reply = (result: unknown): void => chan.port2.postMessage({ id, result })
    switch (method) {
      case 'project.open':
        return reply({ pid: args.pid, role: 'leader' })
      case 'project.close':
        return reply({ ok: true })
      case 'kernel.getUser':
        return reply(state.user)
      case 'fs.list':
        return reply(Object.keys(state.files))
      case 'fs.write':
        state.files[args.path as string] = args.bytes as Uint8Array
        return reply({ ok: true })
      case 'fs.read':
        return reply(state.files[args.path as string] ?? new Uint8Array())
      case 'fs.exists':
        return reply({ exists: (args.path as string) in state.files })
      case 'fs.log':
        return reply(state.log)
      case 'fs.head':
        return reply(state.log[0]?.sha ?? null)
      case 'fs.hasUncommittedChanges':
        return reply({ dirty: false })
      case 'fs.commit': {
        const sha = `sha${state.log.length + 1}`
        state.log.unshift({
          sha,
          message: args.message as string,
          author: (args.author as { name?: string })?.name ?? 'dev',
          authorEmail: (args.author as { email?: string })?.email ?? 'dev@x',
          timestamp: new Date(0),
        })
        return reply({ sha })
      }
      case 'fs.showVersion':
        return reply(new TextEncoder().encode(`@${args.shaLike}`))
      default:
        return reply({})
    }
  }
  return { client: new MythworkClient(chan.port1), state }
}

function mount(client: MythworkClient, ui: React.ReactNode, pid = 'p1') {
  return render(
    <MythworkProvider connect={() => Promise.resolve(client)}>
      <MythworkProjectProvider pid={pid}>{ui}</MythworkProjectProvider>
    </MythworkProvider>,
  )
}

afterEach(() => cleanup())

describe('useUser', () => {
  it('projects a public user and exposes signIn/signOut', async () => {
    const { client } = makeHost({
      user: { kind: 'public', userId: 'u7', displayName: 'Ada', picture: 'pic.png' },
    })
    function Probe(): React.JSX.Element {
      const u = useUser()
      return (
        <div data-testid="u">{`${u.kind}/${u.userId}/${u.name ?? '-'}/${u.picture ?? '-'}/${typeof u.signIn}`}</div>
      )
    }
    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <Probe />
      </MythworkProvider>,
    )
    await waitFor(() => {
      expect(api.queryByTestId('u')?.textContent).toBe('public/u7/Ada/pic.png/function')
    })
  })
})

describe('useFiles', () => {
  it('write→read round-trips through fs.write/fs.read scoped to pid', async () => {
    const { client, state } = makeHost()
    let handle: ReturnType<typeof useFiles> = null
    function Probe(): React.JSX.Element {
      handle = useFiles()
      return <div data-testid="f">{handle ? 'ready' : 'loading'}</div>
    }
    const api = mount(client, <Probe />)
    await waitFor(() => expect(api.queryByTestId('f')?.textContent).toBe('ready'))

    await handle!.write('/index.html', new TextEncoder().encode('<h1>hi</h1>'))
    const bytes = await handle!.read('/index.html')
    expect(new TextDecoder().decode(bytes)).toBe('<h1>hi</h1>')

    const writeCall = state.calls.find(c => c.method === 'fs.write')
    expect(writeCall?.args.pid).toBe('p1')
    expect(writeCall?.args.path).toBe('/index.html')
  })

  it('showVersion maps sha→shaLike on the wire', async () => {
    const { client, state } = makeHost()
    let handle: ReturnType<typeof useFiles> = null
    function Probe(): React.JSX.Element {
      handle = useFiles()
      return <div data-testid="f">{handle ? 'ready' : 'loading'}</div>
    }
    const api = mount(client, <Probe />)
    await waitFor(() => expect(api.queryByTestId('f')?.textContent).toBe('ready'))

    const out = await handle!.showVersion('abc123', '/index.html')
    expect(new TextDecoder().decode(out)).toBe('@abc123')
    const call = state.calls.find(c => c.method === 'fs.showVersion')
    expect(call?.args).toMatchObject({ pid: 'p1', shaLike: 'abc123', path: '/index.html' })
  })
})

describe('useGit', () => {
  it('exposes live log/head and commit() bumps them after refresh()', async () => {
    const { client } = makeHost({
      log: [
        {
          sha: 'sha1',
          message: 'shot 1',
          author: 'A',
          authorEmail: 'a@orbit',
          timestamp: new Date(0),
        },
      ],
    })
    let git: ReturnType<typeof useGit> = null
    function Probe(): React.JSX.Element {
      git = useGit()
      return <div data-testid="g">{git ? `${git.head}/${git.log.length}` : 'loading'}</div>
    }
    const api = mount(client, <Probe />)
    await waitFor(() => expect(api.queryByTestId('g')?.textContent).toBe('sha1/1'))

    // commit with an author override (tennis commits as `${userId}@orbit`),
    // then refresh → live state reflects the new head + log length.
    await git!.commit('shot 2 · smash', { name: 'B', email: 'b@orbit' })
    git!.refresh()
    await waitFor(() => expect(api.queryByTestId('g')?.textContent).toBe('sha2/2'))
  })
})

describe('re-render safety (fetch-loop regression guard)', () => {
  // Guards the exact failure mode that took explore down: a hook keyed on an
  // unstable ref re-fires its fetcher every render (~600 req/s). Each live
  // fetcher must fire EXACTLY once across many re-renders — not once-per-render.
  // A fresh tree (new `connect` arrow + element identity) each pass forces a
  // full reconciliation, the stress the incident exposed.
  it('parent re-renders do not re-fire the live fs.list / fs.log fetchers', async () => {
    const { client, state } = makeHost()
    function Probe(): React.JSX.Element {
      const f = useFiles()
      const g = useGit()
      return <div data-testid="r">{f && g ? 'ready' : 'loading'}</div>
    }
    const makeTree = (): React.JSX.Element => (
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <MythworkProjectProvider pid="p1">
          <Probe />
        </MythworkProjectProvider>
      </MythworkProvider>
    )
    const api = render(makeTree())
    await waitFor(() => expect(api.queryByTestId('r')?.textContent).toBe('ready'))

    for (let i = 0; i < 20; i++) api.rerender(makeTree())
    await waitFor(() => expect(api.queryByTestId('r')?.textContent).toBe('ready'))

    const count = (m: string): number => state.calls.filter(c => c.method === m).length
    expect(count('project.open')).toBe(1)
    expect(count('fs.list')).toBe(1)
    expect(count('fs.log')).toBe(1)
    expect(count('fs.head')).toBe(1)
  })
})
