// @mythwork/sdk/react — project-bound filesystem hook. Ported from
// @orbitcode/file/react: same public shape (live `paths` + imperative
// read/write/list/exists/rename/remove + version-aware commit/log/showVersion/
// diff/checkout + `subscribe`). The pid comes from `useProject()` and the wire
// calls go through `useMythwork().sdk` (fs.* + git.*) instead of the fs-funcs
// shim. Returns null while the client/project is still settling.

import { useEffect, useMemo, useState } from 'react'
import type { CommitAuthor, CommitInfo, DiffEntry } from '@mythwork/protocol'
import { useMythwork } from './platform'
import { useProject } from './project'

export interface FileChangeEvent {
  type: 'fs.changed'
  pid: string
  path: string
  kind: 'created' | 'updated' | 'deleted'
}

export interface FilesHandle {
  /** Live list of file paths under `prefix`, auto-updating on `fs.changed`. */
  paths: string[]
  error: Error | null
  loading: boolean
  read(path: string): Promise<Uint8Array>
  write(path: string, bytes: Uint8Array): Promise<void>
  list(prefix?: string): Promise<string[]>
  exists(path: string): Promise<boolean>
  rename(from: string, to: string): Promise<void>
  remove(path: string): Promise<void>
  commit(message: string, author?: CommitAuthor): Promise<{ sha: string }>
  log(opts?: { depth?: number; skip?: number }): Promise<CommitInfo[]>
  showVersion(sha: string, path: string): Promise<Uint8Array>
  diff(opts?: { sha?: string }): Promise<DiffEntry[]>
  checkout(sha: string): Promise<void>
  /** Subscribe to `fs.changed` for THIS project. Returns an unsubscribe fn. */
  subscribe(handler: (event: FileChangeEvent) => void): () => void
}

/**
 * Single project-bound files hook. Live path list under `prefix` plus imperative
 * file + version ops, all scoped to the current project. The handle is stable
 * per (client, pid, prefix) — only `paths`/`error`/`loading` mutate in place —
 * so callers may list it as an effect dep without churn. Null while loading.
 */
export function useFiles(prefix?: string): FilesHandle | null {
  const { sdk } = useMythwork()
  const { pid } = useProject()
  const [paths, setPaths] = useState<string[]>([])
  const [error, setError] = useState<Error | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!sdk || !pid) {
      setLoading(true)
      setPaths([])
      return
    }
    let cancelled = false
    let inFlight = false
    let pendingRefetch = false

    const refetch = (): void => {
      if (inFlight) {
        pendingRefetch = true
        return
      }
      inFlight = true
      sdk.fs.list({ pid, prefix }).then(
        p => {
          inFlight = false
          if (cancelled) return
          setPaths(p)
          setLoading(false)
          if (pendingRefetch) {
            pendingRefetch = false
            refetch()
          }
        },
        (e: Error) => {
          inFlight = false
          if (!cancelled) {
            setError(e)
            setLoading(false)
          }
        },
      )
    }

    setError(null)
    setLoading(true)
    refetch()
    const off = sdk.fs.onChanged(data => {
      if (data.pid !== pid) return
      refetch()
    })
    return () => {
      cancelled = true
      off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk, pid, prefix])

  const handle = useMemo<FilesHandle | null>(() => {
    if (!sdk || !pid) return null
    return {
      paths: [],
      error: null,
      loading: true,
      read: path => sdk.fs.read({ pid, path }),
      write: (path, bytes) => sdk.fs.write({ pid, path, bytes }).then(() => {}),
      list: p => sdk.fs.list({ pid, prefix: p }),
      exists: path => sdk.fs.exists({ pid, path }).then(r => r.exists),
      rename: (from, to) => sdk.fs.rename({ pid, from, to }).then(() => {}),
      remove: path => sdk.fs.delete({ pid, path }).then(() => {}),
      commit: (message, author) => sdk.git.commit({ pid, message, author }),
      log: opts => sdk.git.log({ pid, depth: opts?.depth, skip: opts?.skip }),
      showVersion: (sha, path) => sdk.git.showVersion({ pid, shaLike: sha, path }),
      diff: opts => sdk.git.diff({ pid, sha: opts?.sha }),
      checkout: sha => sdk.git.checkout({ pid, shaLike: sha }).then(() => {}),
      subscribe: handler =>
        sdk.fs.onChanged(data => {
          if (data.pid !== pid) return
          handler(data as FileChangeEvent)
        }),
    }
  }, [sdk, pid])

  if (handle) {
    handle.paths = paths
    handle.error = error
    handle.loading = loading
  }
  return handle
}
