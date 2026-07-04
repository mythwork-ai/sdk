// @vitest-environment happy-dom
//
// SPIKE / gate: prove the @mythwork/sdk React layer drives real collaborative
// editing end-to-end — `connect()`-style client → sdk.collab.openRoom → a
// Y.Doc bound through useCollabRoom → two peers converge. Also proves the base
// MythworkProvider resolves the user (explore's contract).
//
// The collab server is stood in by an in-memory relay injected as the provider
// factory: docs that join the same roomId exchange Y updates, exactly what
// y-websocket + the Rust collab server do over the wire (which orbit-collab
// already runs in production with this same WebsocketProvider construction).
// What this test exercises for real: the SDK transport, the wire method
// (collab.openRoom), the join-token threading, the Y.Doc/Awareness lifecycle,
// and the React hook contract.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import * as Y from 'yjs'
import { MythworkClient } from '../client'
import {
  _resetCollabForTests,
  _setProviderFactoryForTests,
  MythworkProjectProvider,
  MythworkProvider,
  useCollabRoom,
  useMythwork,
} from './index'

// ── in-memory collab relay (stand-in for the Rust collab server) ──────────────
const relays = new Map<string, Set<Y.Doc>>()
const capturedTokens: (string | undefined)[] = []

function relayProviderFactory(
  _serverUrl: string,
  roomId: string,
  doc: Y.Doc,
  opts: { awareness: unknown; joinToken?: string },
): import('y-websocket').WebsocketProvider {
  capturedTokens.push(opts.joinToken)
  let peers = relays.get(roomId)
  if (!peers) {
    peers = new Set()
    relays.set(roomId, peers)
  }
  // Sync existing room state into the newcomer and vice versa.
  for (const peer of peers) {
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer))
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc))
  }
  peers.add(doc)
  const onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === 'relay') return
    for (const peer of peers) if (peer !== doc) Y.applyUpdate(peer, update, 'relay')
  }
  doc.on('update', onUpdate)

  const statusCbs = new Set<(e: { status: string }) => void>()
  const syncCbs = new Set<(s: boolean) => void>()
  // Minimal WebsocketProvider-shaped stub. Announce connected+synced on the next
  // microtask so the hook's status/sync listeners fire like the real provider's.
  queueMicrotask(() => {
    for (const cb of statusCbs) cb({ status: 'connected' })
    for (const cb of syncCbs) cb(true)
  })
  return {
    awareness: opts.awareness,
    on(ev: string, cb: (...a: never[]) => void) {
      if (ev === 'status') statusCbs.add(cb as (e: { status: string }) => void)
      if (ev === 'sync') syncCbs.add(cb as (s: boolean) => void)
    },
    off() {},
    connect() {},
    connectBc() {},
    destroy() {
      doc.off('update', onUpdate)
      peers.delete(doc)
    },
  } as unknown as import('y-websocket').WebsocketProvider
}

// ── fake host: a MessageChannel whose far side answers the wire methods the
// hooks call. Driven over the real MythworkClient transport. ───────────────────
function makeClient(opts: {
  roomId: string
  joinToken?: string
  user?: { kind: string; userId: string }
}): MythworkClient {
  const chan = new MessageChannel()
  chan.port2.start()
  chan.port2.onmessage = (e: MessageEvent) => {
    const { id, method, args } = e.data as {
      id: string
      method: string
      args: Record<string, unknown>
    }
    switch (method) {
      case 'project.open':
      case 'project.create':
        chan.port2.postMessage({ id, result: { pid: args.pid ?? 'p-new', role: 'leader' } })
        return
      case 'project.close':
        chan.port2.postMessage({ id, result: { ok: true } })
        return
      case 'kernel.getUser':
        chan.port2.postMessage({ id, result: opts.user ?? { kind: 'anonymous', userId: 'anon' } })
        return
      case 'collab.openRoom':
        chan.port2.postMessage({
          id,
          result: { roomId: opts.roomId, serverUrl: 'ws://collab.test', joinToken: opts.joinToken },
        })
        return
      default:
        chan.port2.postMessage({ id, result: {} })
    }
  }
  return new MythworkClient(chan.port1)
}

beforeEach(() => {
  relays.clear()
  capturedTokens.length = 0
  _resetCollabForTests()
})
afterEach(() => {
  cleanup()
  _resetCollabForTests()
})

describe('@mythwork/sdk/react — collab room', () => {
  it('two peers converge a Y.Text through sdk.collab.openRoom + useCollabRoom', async () => {
    _setProviderFactoryForTests(relayProviderFactory)
    const ROOM = 'match-room-abc'
    const clientA = makeClient({ roomId: ROOM, joinToken: 'jt.A' })
    const clientB = makeClient({ roomId: ROOM, joinToken: 'jt.B' })

    let docA: Y.Doc | undefined
    let docB: Y.Doc | undefined
    function Peer({ id }: { id: 'A' | 'B' }): React.JSX.Element {
      const { doc, status } = useCollabRoom({ name: 'index.html', instanceId: id })
      if (doc) {
        if (id === 'A') docA = doc
        else docB = doc
      }
      return <div data-testid={`peer-${id}`}>{doc ? status : 'loading'}</div>
    }

    const a = render(
      <MythworkProvider connect={() => Promise.resolve(clientA)}>
        <MythworkProjectProvider pid="pA">
          <Peer id="A" />
        </MythworkProjectProvider>
      </MythworkProvider>,
    )
    const b = render(
      <MythworkProvider connect={() => Promise.resolve(clientB)}>
        <MythworkProjectProvider pid="pB">
          <Peer id="B" />
        </MythworkProjectProvider>
      </MythworkProvider>,
    )

    await waitFor(() => {
      expect(docA).toBeDefined()
      expect(docB).toBeDefined()
    })
    if (!docA || !docB) throw new Error('both peers should have a doc')
    // const captures keep the narrowed type inside the waitFor closures.
    const dA: Y.Doc = docA
    const dB: Y.Doc = docB

    // Peer A types → Peer B converges.
    dA.getText('index.html').insert(0, '<h1>hello from A</h1>')
    await waitFor(() => {
      expect(dB.getText('index.html').toString()).toBe('<h1>hello from A</h1>')
    })

    // Peer B edits → Peer A converges (bidirectional CRDT merge).
    dB.getText('index.html').insert(0, '<!-- B was here --> ')
    await waitFor(() => {
      expect(dA.getText('index.html').toString()).toBe('<!-- B was here --> <h1>hello from A</h1>')
    })

    // The signed join token from collab.openRoom was threaded to the provider
    // (real wire would append it as `?jt=`).
    expect(capturedTokens).toContain('jt.A')
    expect(capturedTokens).toContain('jt.B')

    // Status propagated from the (stub) provider through the hook.
    await waitFor(() => {
      expect(a.queryByTestId('peer-A')?.textContent).toBe('connected')
      expect(b.queryByTestId('peer-B')?.textContent).toBe('connected')
    })
  })

  it('remount with the same room key returns a live room, not the destroyed one', async () => {
    // Regression: if releaseRoom's pending.then microtask is queued before the
    // next acquireRoom's `await existing`, refcount drops to 0 / cache.delete /
    // destroy runs first, then the new mount receives the destroyed Y.Doc.
    // Triggered in practice by React StrictMode's double-invoke and by any
    // remount (route change, key change) that lands in the same commit as the
    // unmount. After the fix, releaseRoom decrements + cache.delete sync, so
    // the second mount never sees the cached pending and creates a fresh room.
    _setProviderFactoryForTests(relayProviderFactory)
    const client = makeClient({ roomId: 'race-room', joinToken: 'jt' })

    const seen = new Map<string, Y.Doc>()
    function Peer({ tag }: { tag: string }): React.JSX.Element {
      const { doc } = useCollabRoom({ name: 'race' })
      if (doc) seen.set(tag, doc)
      return <div data-testid={`probe-${tag}`}>{doc ? 'ready' : 'loading'}</div>
    }

    const a = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <MythworkProjectProvider pid="pRace">
          <Peer key="m1" tag="m1" />
        </MythworkProjectProvider>
      </MythworkProvider>,
    )
    await waitFor(() => expect(seen.get('m1')).toBeDefined())
    const firstDoc = seen.get('m1') as Y.Doc

    // Force unmount + remount in a single commit by changing the child key.
    // React unmounts <Peer key="m1"> (cleanup → releaseRoom) and mounts
    // <Peer key="m2"> (new effect → acquireRoom) before this rerender returns
    // — no microtask flush in between. Under the bug, both subscribe to the
    // same already-resolved pending and the queued releaseRoom callback runs
    // before the queued acquireRoom continuation, leaving the second mount
    // bound to a destroyed Y.Doc.
    a.rerender(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <MythworkProjectProvider pid="pRace">
          <Peer key="m2" tag="m2" />
        </MythworkProjectProvider>
      </MythworkProvider>,
    )
    await waitFor(() => expect(a.queryByTestId('probe-m2')?.textContent).toBe('ready'))
    const secondDoc = seen.get('m2') as Y.Doc

    // After the fix, the remount must NOT hand back the destroyed Y.Doc — it
    // must allocate a fresh one. Before the fix, secondDoc === firstDoc (and
    // firstDoc has already had destroy() called on it by the released room).
    expect(secondDoc).not.toBe(firstDoc)
  })

  it('local:true binds a Y.Doc with no collab.openRoom round-trip', async () => {
    let openRoomCalls = 0
    const chan = new MessageChannel()
    chan.port2.start()
    chan.port2.onmessage = (e: MessageEvent) => {
      const { id, method, args } = e.data as {
        id: string
        method: string
        args: Record<string, unknown>
      }
      if (method === 'collab.openRoom') openRoomCalls++
      if (method === 'project.open')
        chan.port2.postMessage({ id, result: { pid: args.pid, role: 'leader' } })
      else chan.port2.postMessage({ id, result: { roomId: 'x', serverUrl: 'y' } })
    }
    const client = new MythworkClient(chan.port1)

    function Probe(): React.JSX.Element {
      const { doc, roomId, status } = useCollabRoom({ name: 'editor', local: true })
      if (!doc) return <div data-testid="loading">loading</div>
      return <div data-testid="ready">{`${roomId}|${status}`}</div>
    }
    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <MythworkProjectProvider pid="pLocal">
          <Probe />
        </MythworkProjectProvider>
      </MythworkProvider>,
    )
    await waitFor(() => {
      expect(api.queryByTestId('ready')?.textContent).toBe('local:project:editor|disconnected')
    })
    expect(openRoomCalls).toBe(0)
  })

  it('degrades to a local in-memory doc when collab.openRoom fails (no blank editor)', async () => {
    // If the provider is ever constructed in degraded mode the test fails loud:
    // a degraded room must NOT attempt a websocket.
    _setProviderFactoryForTests(() => {
      throw new Error('provider must not be constructed when degraded to local')
    })
    // A host whose collab.openRoom REJECTS (control plane down/cold).
    const chan = new MessageChannel()
    chan.port2.start()
    chan.port2.onmessage = (e: MessageEvent) => {
      const { id, method, args } = e.data as {
        id: string
        method: string
        args: Record<string, unknown>
      }
      if (method === 'project.open') {
        chan.port2.postMessage({ id, result: { pid: args.pid, role: 'leader' } })
      } else if (method === 'collab.openRoom') {
        chan.port2.postMessage({ id, error: 'collab unavailable' })
      } else {
        chan.port2.postMessage({ id, result: {} })
      }
    }
    const client = new MythworkClient(chan.port1)

    function Probe(): React.JSX.Element {
      const { doc, status, error } = useCollabRoom({ name: 'editor' })
      if (!doc)
        return <div data-testid="loading">{error ? `error:${error.message}` : 'loading'}</div>
      return <div data-testid="ready">{`${status}|${error ? 'err' : 'ok'}`}</div>
    }
    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <MythworkProjectProvider pid="pDegrade">
          <Probe />
        </MythworkProjectProvider>
      </MythworkProvider>,
    )
    // A working (local, in-memory) doc is bound despite the openRoom failure —
    // the editor is NOT left blank, no websocket is attempted, and `error`
    // stays null because we recovered.
    await waitFor(() => {
      expect(api.queryByTestId('ready')?.textContent).toBe('disconnected|ok')
    })
  })

  it('fires a websocket with the production-shaped collab URL for an associated project', async () => {
    // Regression: when collab.openRoom resolves with a real (non-empty) serverUrl
    // — the scenario for any project associated with a canonical id — the SDK
    // MUST attempt the WS with that URL, not degrade to local (serverUrl='').
    // Verifies the `connectWebsocket = ... && serverUrl !== ''` gate (#505) does
    // not accidentally suppress the connection for a real provision response.
    const capturedUrls: string[] = []
    _setProviderFactoryForTests((serverUrl, roomId, doc, opts) => {
      capturedUrls.push(serverUrl)
      return relayProviderFactory(serverUrl, roomId, doc, opts)
    })

    const ROOM_ID = 'room:deadbeef01deadbeef01deadbeef01deadbeef01deadbeef01'
    const WS_URL = 'wss://collab.llama.space'
    const chan = new MessageChannel()
    chan.port2.start()
    chan.port2.onmessage = (e: MessageEvent) => {
      const { id, method, args } = e.data as {
        id: string
        method: string
        args: Record<string, unknown>
      }
      if (method === 'project.open') {
        chan.port2.postMessage({ id, result: { pid: args.pid ?? 'p-assoc', role: 'leader' } })
      } else if (method === 'collab.openRoom') {
        // Response shape matching what the live /room/provision API returns via
        // the collab bridge (canonical project, production zone URL).
        chan.port2.postMessage({
          id,
          result: { roomId: ROOM_ID, serverUrl: WS_URL, joinToken: 'eyJ.live-token' },
        })
      } else {
        chan.port2.postMessage({ id, result: {} })
      }
    }
    const client = new MythworkClient(chan.port1)

    function Probe(): React.JSX.Element {
      const { doc, status } = useCollabRoom({ name: 'index.html' })
      return <div data-testid="probe">{doc ? status : 'loading'}</div>
    }
    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <MythworkProjectProvider pid="pAssociated">
          <Probe />
        </MythworkProjectProvider>
      </MythworkProvider>,
    )

    await waitFor(() => {
      expect(api.queryByTestId('probe')?.textContent).toBe('connected')
    })

    // The provider factory MUST have been called with the real WS URL, not ''.
    expect(capturedUrls).toContain(WS_URL)
    expect(capturedUrls.every(u => u !== '')).toBe(true)
  })

  it('does not attempt a websocket when collab.openRoom RESOLVES with the local descriptor', async () => {
    // Regression: an unassociated project's `collab.openRoom` bridge handler
    // does not reject — it resolves cleanly with `{ roomId: 'local:...',
    // serverUrl: '' }` (see packages/host-iframe/src/bridges/collab.ts). The
    // previous guard only checked `degradedToLocal` (set on a REJECTED
    // openRoom call) and the caller-supplied `local` option — a resolved
    // local descriptor fell through to `connectWebsocket = true` with an
    // empty serverUrl, and y-websocket resolved that against the current
    // page origin, producing a real (CSP-blocked) connection attempt.
    _setProviderFactoryForTests(() => {
      throw new Error('provider must not be constructed for a resolved local descriptor')
    })
    const chan = new MessageChannel()
    chan.port2.start()
    chan.port2.onmessage = (e: MessageEvent) => {
      const { id, method, args } = e.data as {
        id: string
        method: string
        args: Record<string, unknown>
      }
      if (method === 'project.open') {
        chan.port2.postMessage({ id, result: { pid: args.pid, role: 'leader' } })
      } else if (method === 'collab.openRoom') {
        chan.port2.postMessage({ id, result: { roomId: 'local:project:editor', serverUrl: '' } })
      } else {
        chan.port2.postMessage({ id, result: {} })
      }
    }
    const client = new MythworkClient(chan.port1)

    function Probe(): React.JSX.Element {
      const { doc, roomId, status } = useCollabRoom({ name: 'editor' })
      if (!doc) return <div data-testid="loading">loading</div>
      return <div data-testid="ready">{`${roomId}|${status}`}</div>
    }
    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <MythworkProjectProvider pid="pUnassociated">
          <Probe />
        </MythworkProjectProvider>
      </MythworkProvider>,
    )
    await waitFor(() => {
      expect(api.queryByTestId('ready')?.textContent).toBe('local:project:editor|disconnected')
    })
  })
})

describe('@mythwork/sdk/react — base platform contract (explore)', () => {
  it('MythworkProvider resolves the user and derives authStatus', async () => {
    const client = makeClient({ roomId: 'r', user: { kind: 'anonymous', userId: 'anon' } })
    function Probe(): React.JSX.Element {
      const { user, authStatus } = useMythwork()
      return <div data-testid="p">{`${authStatus}/${user?.kind ?? '-'}`}</div>
    }
    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <Probe />
      </MythworkProvider>,
    )
    await waitFor(() => {
      expect(api.queryByTestId('p')?.textContent).toBe('anonymous/anonymous')
    })
  })
})
