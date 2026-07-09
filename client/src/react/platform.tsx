// @mythwork/sdk/react — the base platform provider: connect once, resolve the
// user, expose the client + auth state via context. This is the React surface
// every Mythwork app needs (browsing apps like explore use ONLY this; editor
// apps like tennis layer `MythworkProjectProvider` on top).
//
// The context shape mirrors what apps were hand-rolling (explore's
// `PlatformProvider`/`usePlatform`) so adopting this is a delete-and-reimport,
// not a rewrite: `{ sdk, user, authStatus, signIn, signOut }`.

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { User } from '@mythwork/protocol'
import type { MythworkClient } from '../client'
import { type ConnectOptions, connect as defaultConnect } from '../index'

/** Coarse auth state for conditional rendering. `loading` until the first
 * `getUser()` resolves; `unavailable` if the client never connected. */
export type AuthStatus = 'loading' | 'anonymous' | 'signed-in' | 'unavailable'

function authStatusOf(user: User | null, unavailable: boolean): AuthStatus {
  if (unavailable) return 'unavailable'
  if (!user) return 'loading'
  return user.kind === 'anonymous' ? 'anonymous' : 'signed-in'
}

export interface MythworkContextValue {
  /** The connected client, or null while still connecting / unavailable. */
  sdk: MythworkClient | null
  /** The current platform user, or null while loading. */
  user: User | null
  /** Derived auth status for easy conditional rendering. */
  authStatus: AuthStatus
  /** Trigger the platform sign-in flow (opens the host OAuth popup). */
  signIn(): Promise<void>
  /** Sign out the platform session. */
  signOut(): Promise<void>
  /** Reset and re-run the connect handshake — recovers from `unavailable` without a page reload. */
  retry(): void
}

const MythworkCtx = createContext<MythworkContextValue>({
  sdk: null,
  user: null,
  authStatus: 'loading',
  signIn: async () => {},
  signOut: async () => {},
  retry: () => {},
})

export interface MythworkProviderProps {
  children: ReactNode
  /**
   * How to acquire the client. Defaults to the real {@link connect} handshake
   * (the embedded-iframe path). Apps running un-embedded (a dev server, tests)
   * pass a thunk resolving a DevHost-backed client — exactly the seam explore's
   * `getSdk()` used to special-case internally.
   */
  connect?: () => Promise<MythworkClient>
  /** Passed through to the default `connect()` when no `connect` thunk is given. */
  connectOptions?: ConnectOptions
}

/**
 * Connect to the host once on mount, resolve the current user, and provide the
 * client + auth state to the tree. Never blocks first paint: `sdk` is null until
 * the handshake resolves.
 */
export function MythworkProvider({
  children,
  connect,
  connectOptions,
}: MythworkProviderProps): React.JSX.Element {
  const [sdk, setSdk] = useState<MythworkClient | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const unsubRef = useRef<(() => void) | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: connect/connectOptions are intentionally excluded so a new prop identity never forces a reconnect; attempt is included so retry() re-runs the handshake.
  useEffect(() => {
    let cancelled = false
    // Tear down any previous subscription before re-running.
    unsubRef.current?.()
    unsubRef.current = null
    const acquire = connect ?? ((): Promise<MythworkClient> => defaultConnect(connectOptions))
    acquire()
      .then(client => {
        if (cancelled) return undefined
        setSdk(client)
        // Subscribe BEFORE the first getUser so a push that fires between the
        // read and the subscription isn't dropped.
        unsubRef.current = client.auth.onAuthChanged(({ user: u }) => {
          if (!cancelled) setUser(u)
        })
        return client.auth.getUser()
      })
      .then(u => {
        if (!cancelled && u) setUser(u)
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true)
      })
    return () => {
      cancelled = true
      unsubRef.current?.()
    }
  }, [attempt])

  // Stable actions so downstream hooks (useUser) don't churn identity on every
  // render — they only change when the client does.
  const signIn = useCallback(async () => {
    if (sdk) setUser(await sdk.auth.signIn())
  }, [sdk])
  const signOut = useCallback(async () => {
    if (sdk) setUser(await sdk.auth.signOut())
  }, [sdk])

  const retry = useCallback(() => {
    setSdk(null)
    setUser(null)
    setUnavailable(false)
    setAttempt(n => n + 1)
  }, [])

  const value = useMemo<MythworkContextValue>(
    () => ({ sdk, user, authStatus: authStatusOf(user, unavailable), signIn, signOut, retry }),
    [sdk, user, unavailable, signIn, signOut, retry],
  )

  return <MythworkCtx.Provider value={value}>{children}</MythworkCtx.Provider>
}

/** Access the client + auth state from any component inside a {@link MythworkProvider}. */
export function useMythwork(): MythworkContextValue {
  return useContext(MythworkCtx)
}
