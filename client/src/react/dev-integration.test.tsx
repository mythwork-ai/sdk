// @vitest-environment happy-dom
//
// Full-stack dev test: two `connect({ dev: true })` clients on ONE shared dev
// project, driven through the real React hooks. Proves the whole loop — dev host
// (project/fs/git/collab.openRoom) + installDevCollabRelay + useCollabRoom +
// useGit — converges with NO real host and NO @orbitcode/* dependency. This is
// the harness an editor app (tennis) runs its multiplayer tests on.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { Awareness } from 'y-protocols/awareness'
import * as Y from 'yjs'
import { connect } from '../index'
import { _resetDevHostForTests } from '../dev/host'
import {
  _resetCollabForTests,
  type CollabRoomHandle,
  devCollabRelayFactory,
  installDevCollabRelay,
  MythworkProjectProvider,
  MythworkProvider,
  useCollabRoom,
  useGit,
} from './index'

beforeEach(() => {
  _resetDevHostForTests()
  _resetCollabForTests()
  installDevCollabRelay()
})
afterEach(() => {
  cleanup()
  _resetCollabForTests()
})

describe('@mythwork/sdk dev stack — two peers on connect({ dev: true })', () => {
  it('live Y.Text converges and commits are shared across peers', async () => {
    const clientA = await connect({ dev: true })
    const clientB = await connect({ dev: true })
    // A creates the match; B joins the same pid (URL-shared in the real app).
    const { pid } = await clientA.project.create({ projectName: 'match' })

    let docA: Y.Doc | undefined
    let docB: Y.Doc | undefined
    let gitB: ReturnType<typeof useGit> = null

    function Inner({ id }: { id: 'A' | 'B' }): React.JSX.Element {
      const { doc } = useCollabRoom({ name: 'index.html' })
      const git = useGit()
      if (doc) {
        if (id === 'A') docA = doc
        else docB = doc
      }
      if (id === 'B') gitB = git
      return <div data-testid={`p-${id}`}>{doc ? 'ready' : 'loading'}</div>
    }
    function Peer({ id, client }: { id: 'A' | 'B'; client: typeof clientA }) {
      return (
        <MythworkProvider connect={() => Promise.resolve(client)}>
          <MythworkProjectProvider pid={pid}>
            <Inner id={id} />
          </MythworkProjectProvider>
        </MythworkProvider>
      )
    }

    const a = render(<Peer id="A" client={clientA} />)
    const b = render(<Peer id="B" client={clientB} />)
    await waitFor(() => {
      expect(docA).toBeDefined()
      expect(docB).toBeDefined()
    })
    const dA: Y.Doc = docA!
    const dB: Y.Doc = docB!

    // Live collaborative edit: A types, B converges (CRDT over the dev relay).
    dA.getText('index.html').insert(0, '<h1>rally</h1>')
    await waitFor(() => {
      expect(dB.getText('index.html').toString()).toBe('<h1>rally</h1>')
    })

    // Shared git: A commits a shot; B's useGit picks it up on refresh.
    await clientA.git.commit({
      pid,
      message: 'shot 1 · smash',
      author: { name: 'A', email: 'a@orbit' },
    })
    gitB!.refresh()
    await waitFor(() => {
      expect(gitB!.log.map(c => c.message)).toContain('shot 1 · smash')
    })

    expect(a.queryByTestId('p-A')?.textContent).toBe('ready')
    expect(b.queryByTestId('p-B')?.textContent).toBe('ready')
  })

  it('relay bridges awareness directly (no React)', () => {
    const docA = new Y.Doc()
    const awA = new Awareness(docA)
    const docB = new Y.Doc()
    const awB = new Awareness(docB)
    devCollabRelayFactory('dev:relay', 'room1', docA, { awareness: awA })
    devCollabRelayFactory('dev:relay', 'room1', docB, { awareness: awB })

    awA.setLocalStateField('user', { name: 'Andre' })
    const seen = awB.getStates().get(docA.clientID) as { user?: { name?: string } } | undefined
    expect(seen?.user?.name).toBe('Andre')
  })

  it('awareness presence converges across peers (relay bridges awareness)', async () => {
    const clientA = await connect({ dev: true })
    const clientB = await connect({ dev: true })
    const { pid } = await clientA.project.create({ projectName: 'match' })

    let roomA: CollabRoomHandle | undefined
    let roomB: CollabRoomHandle | undefined
    function Inner({ id }: { id: 'A' | 'B' }): React.JSX.Element {
      const room = useCollabRoom({ name: 'index.html' })
      if (id === 'A') roomA = room
      else roomB = room
      return <div data-testid={`p-${id}`}>{room.doc ? 'ready' : 'loading'}</div>
    }
    function Peer({ id, client }: { id: 'A' | 'B'; client: typeof clientA }) {
      return (
        <MythworkProvider connect={() => Promise.resolve(client)}>
          <MythworkProjectProvider pid={pid}>
            <Inner id={id} />
          </MythworkProjectProvider>
        </MythworkProvider>
      )
    }
    render(<Peer id="A" client={clientA} />)
    render(<Peer id="B" client={clientB} />)
    await waitFor(() => {
      expect(roomA?.doc).toBeTruthy()
      expect(roomB?.doc).toBeTruthy()
    })

    // A announces presence; B should see A as a non-local collaborator.
    roomA!.setAwareness('user', { name: 'Andre', email: 'andre@x' })
    await waitFor(() => {
      const remote = roomB!.collaborators.find(c => !c.isLocal)
      expect(remote?.name).toBe('Andre')
    })
  })
})
