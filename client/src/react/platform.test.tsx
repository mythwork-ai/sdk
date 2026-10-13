// @vitest-environment happy-dom
//
// Contract tests for MythworkProvider: connection lifecycle, retry() recovery,
// the authStatus state machine, and the RouterSync wiring (does the provider
// call useHostLocationSync when — and only when — it's rendered inside a
// Router) — all against a fake connect() thunk backed by a fake
// MessageChannel host, so no real platform is required.
//
// The RouterSync tests mock useInRouterContext and useHostLocationSync
// directly rather than rendering a real Router: use-host-location-sync.test.tsx
// already exhaustively covers that hook's own behavior — these tests only
// need to pin the provider's wiring decision (mount RouterSync iff
// useInRouterContext() is true, always passing the current sdk through).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MythworkClient } from '../client'
import { MythworkProvider, useMythwork } from './index'

vi.mock('react-router-dom', () => ({ useInRouterContext: vi.fn() }))
import { useInRouterContext } from 'react-router-dom'

vi.mock('./use-host-location-sync', () => ({ useHostLocationSync: vi.fn() }))
import { useHostLocationSync } from './use-host-location-sync'

afterEach(() => {
  cleanup()
  vi.mocked(useInRouterContext).mockReset()
  vi.mocked(useHostLocationSync).mockReset()
})

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

describe('MythworkProvider — RouterSync wiring', () => {
  it('calls useHostLocationSync with the connected client when rendered inside a router', async () => {
    vi.mocked(useInRouterContext).mockReturnValue(true)
    const client = makeClient()

    const { queryByTestId } = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <Probe />
      </MythworkProvider>,
    )

    await waitFor(() => expect(queryByTestId('status')?.textContent).toBe('anonymous'))
    // Reference-identity check, not toHaveBeenCalledWith: MythworkClient holds
    // circular internal references, and vitest's deep-equality diffing on a
    // mismatch/pending call overflows the stack walking them.
    await waitFor(() =>
      expect(vi.mocked(useHostLocationSync).mock.calls.some(call => call[0] === client)).toBe(true),
    )
  })

  it('never calls useHostLocationSync when not rendered inside a router', async () => {
    vi.mocked(useInRouterContext).mockReturnValue(false)
    const client = makeClient()

    const { queryByTestId } = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <Probe />
      </MythworkProvider>,
    )

    await waitFor(() => expect(queryByTestId('status')?.textContent).toBe('anonymous'))
    expect(useHostLocationSync).not.toHaveBeenCalled()
  })
})

describe('MythworkProvider — signIn', () => {
  function recordingClient(): { client: MythworkClient; signIns: unknown[] } {
    const signIns: unknown[] = []
    const chan = new MessageChannel()
    chan.port2.start()
    chan.port2.onmessage = (e: MessageEvent) => {
      const { id, method, args } = e.data as { id: string; method: string; args: unknown }
      if (method === 'kernel.signIn') signIns.push(args)
      chan.port2.postMessage({ id, result: { kind: 'anonymous', userId: 'anon' } })
    }
    return { client: new MythworkClient(chan.port1), signIns }
  }

  function SignIn({ hint }: { hint?: unknown }): React.JSX.Element {
    const { authStatus, signIn } = useMythwork()
    return (
      <button
        type="button"
        data-testid="go"
        disabled={authStatus === 'loading'}
        // Hint-less: an untyped JS caller passing signIn straight to onClick,
        // so the click event lands in its first param. The cast stands in
        // for the missing types; TypeScript rejects this call.
        onClick={hint === undefined ? (signIn as () => void) : () => signIn(hint as never)}>
        go
      </button>
    )
  }

  async function clickGo(hint?: unknown): Promise<unknown[]> {
    const { client, signIns } = recordingClient()
    const { getByTestId } = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <SignIn hint={hint} />
      </MythworkProvider>,
    )
    await waitFor(() => expect((getByTestId('go') as HTMLButtonElement).disabled).toBe(false))
    getByTestId('go').click()
    await waitFor(() => expect(signIns).toHaveLength(1))
    return signIns
  }

  it('passes intent and terms through to kernel.signIn', async () => {
    expect(await clickGo({ intent: 'signup', acceptedTerms: '2026-09-16' })).toEqual([
      { intent: 'signup', acceptedTerms: '2026-09-16' },
    ])
  })

  it('sends empty params when an untyped caller hands it straight to onClick', async () => {
    expect(await clickGo()).toEqual([{}])
  })
})
