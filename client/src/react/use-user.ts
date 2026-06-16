// @mythwork/sdk/react — per-app identity hook, a thin projection over
// `useMythwork()`. Ported from @orbitcode/auth/react: same public shape
// ({ userId, kind, name?, picture?, signIn, signOut }), but the user + actions
// come from the base MythworkProvider context rather than the kernel shim.
//
// While the client is still connecting, `useMythwork().user` is null — surfaced
// here as a synthetic `kind: 'pending'` identity so apps can render it exactly
// like a signed-out anonymous user until the real identity settles.

import { useMemo } from 'react'
import type { User } from '@mythwork/protocol'
import { useMythwork } from './platform'

export interface UseUserResult {
  userId: string
  kind: 'pending' | 'anonymous' | 'pseudonymous' | 'public'
  name?: string
  picture?: string
  /** Reserved for parity with the orbit surface; not populated by the host. */
  email?: string
  /** Trigger the platform sign-in + identity-selection flow. State updates via
   * the authChanged push — callers don't need to setState themselves. */
  signIn(): Promise<void>
  /** Sign out the platform session; state reverts to anonymous via the push. */
  signOut(): Promise<void>
}

function project(
  user: User | null,
  signIn: () => Promise<void>,
  signOut: () => Promise<void>,
): UseUserResult {
  if (!user) return { userId: '', kind: 'pending', signIn, signOut }
  const base: UseUserResult = { userId: user.userId, kind: user.kind, signIn, signOut }
  if (user.kind === 'pseudonymous') {
    base.name = user.displayName
  } else if (user.kind === 'public') {
    base.name = user.displayName
    base.picture = user.picture
  }
  return base
}

export function useUser(): UseUserResult {
  const { user, signIn, signOut } = useMythwork()
  return useMemo(() => project(user, signIn, signOut), [user, signIn, signOut])
}
