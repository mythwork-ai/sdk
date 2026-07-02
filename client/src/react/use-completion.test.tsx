// @vitest-environment happy-dom
//
// Contract tests for useCompletion: streaming accumulation, isStreaming toggle,
// and stop() abort without surfacing an error. Uses the dev host with firstParty
// mode so anonymous ai.complete calls resolve instead of throwing.

import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { connect } from '../index'
import { _resetDevHostForTests } from '../dev/host'
import { MythworkProvider, useMythwork, useCompletion } from './index'

beforeEach(() => {
  _resetDevHostForTests()
})
afterEach(() => {
  cleanup()
})

// Helper: wait for the sdk to connect (authStatus leaves 'loading').
async function waitForSdk(api: ReturnType<typeof render>): Promise<void> {
  await waitFor(() => {
    const el = api.queryByTestId('status')
    expect(el?.textContent).not.toBe('loading')
  })
}

describe('useCompletion', () => {
  it('streams text into state and toggles isStreaming true→false', async () => {
    const client = await connect({ dev: { firstParty: true } })
    let handle: ReturnType<typeof useCompletion> | null = null

    function Probe(): React.JSX.Element {
      const { authStatus } = useMythwork()
      handle = useCompletion()
      return (
        <div>
          <span data-testid="status">{authStatus}</span>
          <span data-testid="text">{handle.text}</span>
          <span data-testid="streaming">{String(handle.isStreaming)}</span>
        </div>
      )
    }

    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <Probe />
      </MythworkProvider>,
    )

    await waitForSdk(api)

    let result: string
    await act(async () => {
      result = await handle!.complete('hello')
    })

    // The dev host returns "(dev) hello" for prompt "hello" in firstParty mode.
    expect(result!).toBe('(dev) hello')
    expect(handle!.text).toBe('(dev) hello')
    expect(handle!.isStreaming).toBe(false)
    expect(handle!.error).toBeNull()
  })

  it('stop() aborts the in-flight stream and does not surface an error', async () => {
    const client = await connect({ dev: { firstParty: true } })
    let handle: ReturnType<typeof useCompletion> | null = null

    function Probe(): React.JSX.Element {
      const { authStatus } = useMythwork()
      handle = useCompletion()
      return (
        <div>
          <span data-testid="status">{authStatus}</span>
          <span data-testid="streaming">{String(handle.isStreaming)}</span>
        </div>
      )
    }

    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <Probe />
      </MythworkProvider>,
    )

    await waitForSdk(api)

    await act(async () => {
      // Start the stream then stop immediately — aborts before the dev host replies.
      const p = handle!.complete('hello')
      handle!.stop()
      await p.catch(() => {}) // swallow the AbortError rejection
    })

    expect(handle!.error).toBeNull()
    expect(handle!.isStreaming).toBe(false)
  })

  it('second complete() supersedes the first — state reflects the second call only', async () => {
    const client = await connect({ dev: { firstParty: true } })
    let handle: ReturnType<typeof useCompletion> | null = null

    function Probe(): React.JSX.Element {
      const { authStatus } = useMythwork()
      handle = useCompletion()
      return (
        <div>
          <span data-testid="status">{authStatus}</span>
          <span data-testid="text">{handle.text}</span>
          <span data-testid="streaming">{String(handle.isStreaming)}</span>
        </div>
      )
    }

    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <Probe />
      </MythworkProvider>,
    )

    await waitForSdk(api)

    let secondResult: string
    await act(async () => {
      // Fire first call without awaiting — the second call aborts it.
      const p1 = handle!.complete('first').catch(() => {}) // swallow AbortError
      // Second call starts immediately, aborting the first mid-flight.
      secondResult = await handle!.complete('second')
      await p1
    })

    // State must reflect the SECOND call exclusively — no clobbering from the
    // first call's late onChunk deltas or its catch/finally setIsStreaming(false).
    expect(secondResult!).toBe('(dev) second')
    expect(handle!.text).toBe('(dev) second')
    expect(handle!.isStreaming).toBe(false)
    expect(handle!.error).toBeNull()
  })

  it('error state is set on non-abort failures', async () => {
    const client = await connect({ dev: true }) // dev host, anonymous, no firstParty → ai.* throws
    let handle: ReturnType<typeof useCompletion> | null = null

    function Probe(): React.JSX.Element {
      const { authStatus } = useMythwork()
      handle = useCompletion()
      return (
        <div>
          <span data-testid="status">{authStatus}</span>
        </div>
      )
    }

    const api = render(
      <MythworkProvider connect={() => Promise.resolve(client)}>
        <Probe />
      </MythworkProvider>,
    )

    await waitForSdk(api)

    await act(async () => {
      await handle!.complete('hello').catch(() => {})
    })

    expect(handle!.error).toBeInstanceOf(Error)
    expect(handle!.isStreaming).toBe(false)
  })
})
