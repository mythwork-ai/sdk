// @mythwork/sdk/react — bridges an app's in-iframe router to the host frame's
// real, top-level address bar, entirely over the SDK's postMessage channel,
// never by reloading the iframe.
//
// Every Mythwork app runs embedded inside the platform host frame: its
// router's `history.pushState` only ever touches the IFRAME's own session
// history, which the host's real address bar never learns about — clicking
// an in-app link doesn't move the visible URL, and a top-level reload
// re-mounts the iframe at its default route, losing the visitor's place.
//
// Unlike this module's other hooks (useFiles, useGit, useCompletion), this
// one takes `sdk` as an explicit argument rather than pulling it from
// useMythwork() — not every app has adopted the shared MythworkProvider yet,
// and this hook needs to work the same way regardless of how an app resolves
// its client.
//
// react-router-dom's useLocation/useNavigate are router-mode-agnostic: this
// works unchanged under BrowserRouter, HashRouter, or MemoryRouter.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { getInitialPath } from '../index'
import type { MythworkClient } from '../client'

/**
 * - On first mount: if the host supplied a different boot path (a deep link,
 *   a refresh, or a restored back/forward state), jump the router there once.
 * - Every route change after: report the new path so the host can mirror it
 *   with its own `history.pushState` — a real navigation is never involved,
 *   so the iframe is never reloaded.
 * - Host-initiated navigation (the visitor pressed back/forward at the top
 *   level): move the router in place and skip re-reporting that hop — the
 *   host already knows where it sent us.
 *
 * No-ops entirely when `sdk` is null (standalone dev, no host frame).
 */
export function useHostLocationSync(sdk: MythworkClient | null): void {
  const location = useLocation()
  const navigate = useNavigate()
  const appliedInitialPath = useRef(false)
  const suppressNextReport = useRef(false)

  // Layout effect (not a plain effect): fires before the browser paints, so a
  // boot path other than "/" replaces the route before the default route is
  // ever visible instead of flashing it first.
  useLayoutEffect(() => {
    if (!sdk || appliedInitialPath.current) return
    appliedInitialPath.current = true
    const initialPath = getInitialPath()
    const here = location.pathname + location.search + location.hash
    if (initialPath && initialPath !== here) {
      suppressNextReport.current = true
      navigate(initialPath, { replace: true })
    }
    // Only ever runs once (guarded by appliedInitialPath) — deps cover the
    // values it actually reads on that one run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk])

  useEffect(() => {
    if (!sdk) return
    return sdk.nav.onNavigate(({ path }) => {
      suppressNextReport.current = true
      navigate(path, { replace: true })
    })
  }, [sdk, navigate])

  useEffect(() => {
    if (!sdk) return
    if (suppressNextReport.current) {
      suppressNextReport.current = false
      return
    }
    const path = location.pathname + location.search + location.hash
    void sdk.nav.reportLocation({ path }).catch(() => {})
  }, [sdk, location])
}
