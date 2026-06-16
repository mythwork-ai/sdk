// @mythwork/sdk/react — project-bound git hook. Ported from @orbitcode/git/react:
// same public shape (live head/log/hasUncommittedChanges + imperative
// commit/checkout/deleteCommit/editCommitMessage/commitTree/flushDirty/show +
// one-shot getHead/getHasUncommittedChanges + manual refresh). The pid comes
// from `useProject()` and the wire calls go through `useMythwork().sdk.git`.
//
// refresh() is manual (apps wire `files.subscribe(() => git.refresh())` to track
// remote commits) — matching the orbit contract tennis was written against.
// Returns null while the client/project is still settling.

import { useEffect, useMemo, useState } from 'react'
import type { CommitAuthor, CommitInfo } from '@mythwork/protocol'
import { useMythwork } from './platform'
import { useProject } from './project'

export interface GitHandle {
  head: string | null
  log: CommitInfo[]
  hasUncommittedChanges: boolean
  error: Error | null
  loading: boolean
  commit(message: string, author?: CommitAuthor): Promise<{ sha: string }>
  checkout(sha: string): Promise<void>
  deleteCommit(sha: string): Promise<{ newHead: string }>
  editCommitMessage(sha: string, message: string): Promise<void>
  commitTree(sourceSha: string, message: string, author?: CommitAuthor): Promise<{ sha: string }>
  flushDirty(): Promise<void>
  show(sha: string, path: string): Promise<Uint8Array>
  /** One-shot head fetch for callbacks needing the freshest head. */
  getHead(): Promise<string | null>
  /** One-shot dirty check for callbacks needing it synchronously. */
  getHasUncommittedChanges(): Promise<boolean>
  /** Re-fetch head + log + hasUncommittedChanges. */
  refresh(): void
}

/**
 * Single project-bound git hook. Live head/log/hasUncommittedChanges plus
 * imperative ops. The handle identity is stable per (client, pid); only the
 * live-state fields mutate in place across refreshes, so callers can list `git`
 * as an effect dep without churn. Null while loading.
 */
export function useGit(opts?: { depth?: number }): GitHandle | null {
  const { sdk } = useMythwork()
  const { pid } = useProject()
  const depth = opts?.depth
  const [state, setState] = useState<{
    head: string | null
    log: CommitInfo[]
    hasUncommittedChanges: boolean
  }>({ head: null, log: [], hasUncommittedChanges: false })
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshKey, setRefreshKey] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the imperative refetch trigger (bumped by refresh()), intentionally a dep though not read in the effect body.
  useEffect(() => {
    if (!sdk || !pid) {
      setLoading(true)
      setState({ head: null, log: [], hasUncommittedChanges: false })
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.all([
      sdk.git.log({ pid, depth }),
      sdk.git.head({ pid }).catch(() => null as string | null),
      sdk.git
        .hasUncommittedChanges({ pid })
        .then(r => r.dirty)
        .catch(() => false),
    ]).then(
      ([commits, h, dirty]) => {
        if (cancelled) return
        const resolvedHead = h ?? (commits.length > 0 ? (commits[0]?.sha ?? null) : null)
        setState({ head: resolvedHead, log: commits, hasUncommittedChanges: dirty })
        setLoading(false)
      },
      (e: Error) => {
        if (cancelled) return
        setError(e)
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [sdk, pid, depth, refreshKey])

  const handle = useMemo<GitHandle | null>(() => {
    if (!sdk || !pid) return null
    return {
      head: null,
      log: [],
      hasUncommittedChanges: false,
      error: null,
      loading: true,
      commit: (message, author) => sdk.git.commit({ pid, message, author }),
      checkout: sha => sdk.git.checkout({ pid, shaLike: sha }).then(() => {}),
      deleteCommit: sha => sdk.git.deleteCommit({ pid, sha }),
      editCommitMessage: (sha, message) =>
        sdk.git.editCommitMessage({ pid, sha, newMessage: message }).then(() => {}),
      commitTree: (sourceSha, message, author) =>
        sdk.git.commitTree({ pid, sourceSha, message, author }),
      flushDirty: () => sdk.git.flushDirty({ pid }).then(() => {}),
      show: (sha, path) => sdk.git.showVersion({ pid, shaLike: sha, path }),
      getHead: () => sdk.git.head({ pid }),
      getHasUncommittedChanges: () => sdk.git.hasUncommittedChanges({ pid }).then(r => r.dirty),
      refresh: () => setRefreshKey(k => k + 1),
    }
  }, [sdk, pid])

  if (handle) {
    handle.head = state.head
    handle.log = state.log
    handle.hasUncommittedChanges = state.hasUncommittedChanges
    handle.error = error
    handle.loading = loading
  }
  return handle
}
