// @vitest-environment happy-dom
//
// Contract tests for MythworkProvider: connection lifecycle, retry() recovery,
// and the authStatus state machine — all against a fake connect() thunk backed
// by a fake MessageChannel host, so no real platform is required.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MythworkClient } from '../client'
import { MythworkProvider, useMythwork } from './index'

afterEach(() => cleanup())

// Build a minimal fake host backed by a real MessageChannel. Supports
// kernel.getUser + kernel.auth.onAuthChanged (via auth.getUser on the wire).
function makeClient(opts?: { user?: { kind: string; userId: string } }): MythworkClient {
  const user = opts?.user ?? { kind: 'anonymous', userId: 'anon' }
  const chan = new MessageChannel()
  chan.port2.start()
  chan.port2.onmessage = (e: MessageEvent) => {
    const { id, method } = e.data as { id: string; method: string }
    const reply = (result: unknown): void => chan.port2.postMessage({ id, result })
    switch (method) {
      case 'kernel.getUser':
        return reply(user)
      default:
        return reply({})
    }
  }
  return new MythworkClient(chan.port1)
}

// Probe component that reads authStatus from context and exposes it.
function Probe(): React.JSX.Element {
  const { authStatus, retry } = useMythwork()
  return (
    <div>
      <span data-testid="status">{authStatus}</span>
      <button type="button" data-testid="retry" onClick={retry}>
        retry
      </button>
    </div>
  )
}

describe('MythworkProvider — basic connection', () => {
  it('resolves to anonymous authStatus after a successful connect', async () => {
    const client = makeClient()
    const { queryByTestId } = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <Probe />
      </MythworkProvider>,
    )
    // Initially loading.
    expect(queryByTestId('status')?.textContent).toBe('loading')
    await waitFor(() => expect(queryByTestId('status')?.textContent).toBe('anonymous'))
  })

  it('sets authStatus to unavailable when connect rejects', async () => {
    const { queryByTestId } = render(
      <MythworkProvider connect={() => Promise.reject(new Error('no host'))}>
        <Probe />
      </MythworkProvider>,
    )
    await waitFor(() => expect(queryByTestId('status')?.textContent).toBe('unavailable'))
  })
})

describe('MythworkProvider — retry()', () => {
  it('retry() resets unavailable → loading → anonymous after a now-resolving connect', async () => {
    let calls = 0
    // First call rejects; second resolves.
    const client = makeClient()
    const connectFn = (): Promise<MythworkClient> => {
      calls += 1
      if (calls === 1) return Promise.reject(new Error('first attempt fails'))
      return Promise.resolve(client)
    }

    const { queryByTestId, getByTestId } = render(
      <MythworkProvider connect={connectFn}>
        <Probe />
      </MythworkProvider>,
    )

    // Wait for first attempt to land as unavailable.
    await waitFor(() => expect(queryByTestId('status')?.textContent).toBe('unavailable'))

    // Click retry → provider re-runs connect (second call resolves).
    getByTestId('retry').click()

    // Should pass through loading then settle on anonymous.
    await waitFor(() => expect(queryByTestId('status')?.textContent).toBe('anonymous'))
    expect(calls).toBe(2)
  })
})
