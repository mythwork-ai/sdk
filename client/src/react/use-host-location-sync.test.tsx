// @vitest-environment happy-dom
//
// Contract tests for useHostLocationSync: boot-path redirect, reportLocation
// on route changes (with the host-initiated echo suppressed), and applying a
// host-pushed nav.navigate. Uses a fake MythworkClient double (not the dev
// host) since standalone dev has no host frame to push nav.navigate from —
// the wire-level nav.reportLocation/onNavigate contract itself is already
// covered by client.test.ts.
//
// react-router-dom itself is mocked with a tiny in-memory fake: a real
// <MemoryRouter> race its own history-sync effect (a plain useEffect) against
// this hook's boot-path useLayoutEffect under happy-dom, and the router never
// observably catches up within this hook's initial mount — an environment
// quirk unrelated to this hook's logic (a click-triggered or useEffect-timed
// navigate() both work fine against the real router). The fake below gives
// the hook a real, synchronously-consistent location/navigate contract to
// drive instead, so these tests pin the hook's actual behavior rather than
// react-router's mount-timing internals under this harness.

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useHostLocationSync } from './use-host-location-sync'
import type { MythworkClient } from '../client'

interface FakeLocation {
  pathname: string
  search: string
  hash: string
}

function parseLocation(to: string): FakeLocation {
  const hashIdx = to.indexOf('#')
  const hash = hashIdx >= 0 ? to.slice(hashIdx) : ''
  const rest = hashIdx >= 0 ? to.slice(0, hashIdx) : to
  const searchIdx = rest.indexOf('?')
  const search = searchIdx >= 0 ? rest.slice(searchIdx) : ''
  const pathname = searchIdx >= 0 ? rest.slice(0, searchIdx) : rest
  return { pathname, search, hash }
}

const FakeRouterCtx = createContext<{
  location: FakeLocation
  navigate: (to: string, opts?: { replace?: boolean }) => void
} | null>(null)

vi.mock('react-router-dom', () => ({
  useLocation: () => {
    const ctx = useContext(FakeRouterCtx)
    if (!ctx) throw new Error('useLocation called outside FakeRouter')
    return ctx.location
  },
  useNavigate: () => {
    const ctx = useContext(FakeRouterCtx)
    if (!ctx) throw new Error('useNavigate called outside FakeRouter')
    return ctx.navigate
  },
}))

vi.mock('../index', async importOriginal => {
  const actual = await importOriginal<typeof import('../index')>()
  return { ...actual, getInitialPath: vi.fn() }
})
import { getInitialPath } from '../index'

function FakeRouter({
  initialPath,
  children,
}: {
  initialPath: string
  children: ReactNode
}): React.JSX.Element {
  const [location, setLocation] = useState<FakeLocation>(() => parseLocation(initialPath))
  const navigate = useCallback((to: string) => setLocation(parseLocation(to)), [])
  return <FakeRouterCtx.Provider value={{ location, navigate }}>{children}</FakeRouterCtx.Provider>
}

afterEach(() => {
  cleanup()
})

function fakeSdk(): {
  sdk: MythworkClient
  reportLocation: ReturnType<typeof vi.fn>
  pushNavigate: (path: string) => void
} {
  const reportLocation = vi.fn().mockResolvedValue({ ok: true })
  let handler: ((params: { path: string }) => void) | undefined
  const sdk = {
    nav: {
      reportLocation,
      onNavigate: (h: (params: { path: string }) => void) => {
        handler = h
        return () => {
          handler = undefined
        }
      },
    },
  } as unknown as MythworkClient
  return {
    sdk,
    reportLocation,
    pushNavigate: path => handler?.({ path }),
  }
}

function Probe({ sdk }: { sdk: MythworkClient | null }): React.JSX.Element {
  useHostLocationSync(sdk)
  const ctx = useContext(FakeRouterCtx)
  return <span data-testid="path">{ctx?.location.pathname}</span>
}

describe('useHostLocationSync', () => {
  beforeEach(() => {
    vi.mocked(getInitialPath).mockReset()
  })

  it('redirects once on mount when the host supplies a different initial path', async () => {
    vi.mocked(getInitialPath).mockReturnValue('/showcase')
    const { sdk } = fakeSdk()

    const api = render(
      <FakeRouter initialPath="/">
        <Probe sdk={sdk} />
      </FakeRouter>,
    )

    await waitFor(() => expect(api.getByTestId('path').textContent).toBe('/showcase'))
  })

  it('does not redirect when the initial path matches the current route', async () => {
    vi.mocked(getInitialPath).mockReturnValue('/')
    const { sdk, reportLocation } = fakeSdk()

    const api = render(
      <FakeRouter initialPath="/">
        <Probe sdk={sdk} />
      </FakeRouter>,
    )

    expect(api.getByTestId('path').textContent).toBe('/')
    // The one report that does happen is the current (unredirected) path.
    await waitFor(() => expect(reportLocation).toHaveBeenCalledWith({ path: '/' }))
    expect(reportLocation).toHaveBeenCalledTimes(1)
  })

  it('reports every route change to the host', async () => {
    vi.mocked(getInitialPath).mockReturnValue(undefined)
    const { sdk, reportLocation } = fakeSdk()

    render(
      <FakeRouter initialPath="/about">
        <Probe sdk={sdk} />
      </FakeRouter>,
    )

    await waitFor(() => expect(reportLocation).toHaveBeenCalledWith({ path: '/about' }))
  })

  it('applies a host-pushed nav.navigate without re-reporting the echo', async () => {
    vi.mocked(getInitialPath).mockReturnValue(undefined)
    const { sdk, reportLocation, pushNavigate } = fakeSdk()

    const api = render(
      <FakeRouter initialPath="/">
        <Probe sdk={sdk} />
      </FakeRouter>,
    )

    await waitFor(() => expect(reportLocation).toHaveBeenCalledWith({ path: '/' }))
    reportLocation.mockClear()

    pushNavigate('/pricing')

    await waitFor(() => expect(api.getByTestId('path').textContent).toBe('/pricing'))
    // The host already knows where it sent us — this hop must not be echoed back.
    expect(reportLocation).not.toHaveBeenCalled()
  })

  it('no-ops entirely when sdk is null', async () => {
    vi.mocked(getInitialPath).mockReturnValue('/showcase')

    const api = render(
      <FakeRouter initialPath="/">
        <Probe sdk={null} />
      </FakeRouter>,
    )

    // No host to sync with — stays exactly where the router put it.
    expect(api.getByTestId('path').textContent).toBe('/')
  })
})
