// @mythwork/sdk/react — the project layer. Editor apps (tennis) mount a
// `MythworkProjectProvider` to open (or create) a project; the project-scoped
// hooks (`useCollabRoom`, `useFiles`, `useGit`) read the pid from here and the
// client from `useMythwork()`. Browsing apps (explore) never mount this.

import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import type { ProjectInfo, ProjectRole } from '@mythwork/protocol'
import { useMythwork } from './platform'

export interface MythworkProjectValue {
  /** The opened project's local handle id, or null until ready. */
  pid: string | null
  /** This session's role for the project. */
  role: ProjectRole | null
  status: 'loading' | 'ready' | 'error'
  error: Error | null
}

const ProjectCtx = createContext<MythworkProjectValue>({
  pid: null,
  role: null,
  status: 'loading',
  error: null,
})

export interface MythworkProjectProviderProps {
  children: ReactNode
  /** Open an existing project by local handle id. */
  pid?: string
  /** Or create a new project with these params (used when `pid` is absent). */
  create?: { projectName?: string; localId?: string }
}

/**
 * Open (or create) a project and provide its `{ pid, role }` to the tree. Closes
 * the project on unmount when it was opened by id. Keyed effects so remounting
 * with a different `pid` re-opens cleanly (tennis renders one provider per match,
 * keyed on pid).
 */
export function MythworkProjectProvider({
  children,
  pid,
  create,
}: MythworkProjectProviderProps): React.JSX.Element {
  const { sdk } = useMythwork()
  const [state, setState] = useState<MythworkProjectValue>({
    pid: null,
    role: null,
    status: 'loading',
    error: null,
  })

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-open only when the project identity changes; keyed on create's scalar fields (not the object) so an equal-but-new create prop doesn't reopen.
  useEffect(() => {
    if (!sdk) return
    let cancelled = false
    const opened: Promise<ProjectInfo> = pid
      ? sdk.project.open({ pid })
      : sdk.project.create(create ?? {})
    opened
      .then(info => {
        if (!cancelled) setState({ pid: info.pid, role: info.role, status: 'ready', error: null })
      })
      .catch((e: Error) => {
        if (!cancelled) setState({ pid: null, role: null, status: 'error', error: e })
      })
    return () => {
      cancelled = true
      if (pid) void sdk.project.close({ pid }).catch(() => {})
    }
  }, [sdk, pid, create?.projectName, create?.localId])

  return <ProjectCtx.Provider value={state}>{children}</ProjectCtx.Provider>
}

/** Read the current project's `{ pid, role, status }` from context. */
export function useProject(): MythworkProjectValue {
  return useContext(ProjectCtx)
}
