// Low-level transport over a live MessagePort: id-correlated requests and
// prefix-matched push subscription. This is the mechanical core the typed
// client (client.ts) is built on. Wire format: `{ id, method, args }` out,
// `{ id, result }` | `{ id, error }` back, id-less `{ type, ... }` pushes
// routed by prefix.

import { DEFAULT_REQUEST_TIMEOUT_MS, type PushMessage, type RpcResponse } from '@mythwork/protocol'

/** Per-call options shared by {@link requestOverPort} and the typed client. */
export interface RequestOptions {
  /**
   * Reject the request if no reply arrives within this many milliseconds.
   * Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}.
   */
  timeoutMs?: number
}

/** A handler invoked with the full push payload (including its `type` field). */
export type PushHandler = (message: PushMessage) => void

let seq = 0

/**
 * Send one RPC request over an already-open {@link MessagePort} and resolve with
 * the correlated reply's `result`, or reject with an `Error` carrying the wire
 * error string. The `id` is allocated internally and matched against incoming
 * replies, so many requests may be in flight on one port concurrently without
 * cross-talk. Pushes (which carry no `id`) are ignored here.
 *
 * Exported as the low-level seam; most callers use the typed
 * {@link import('./client').MythworkClient.request} instead.
 */
export function requestOverPort<R = unknown>(
  port: MessagePort,
  method: string,
  args: Record<string, unknown>,
  opts?: RequestOptions,
): Promise<R> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  return new Promise<R>((resolve, reject) => {
    const id = String(seq++)
    let timer: ReturnType<typeof setTimeout> | null = null
    const handler = (e: MessageEvent) => {
      const d = e.data as RpcResponse | null
      if (!d || d.id !== id) return
      if (timer) clearTimeout(timer)
      port.removeEventListener('message', handler)
      if (d.error) reject(new Error(d.error))
      else resolve(d.result as R)
    }
    port.addEventListener('message', handler)
    timer = setTimeout(() => {
      port.removeEventListener('message', handler)
      reject(new Error(`@mythwork/sdk: request "${method}" timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    port.postMessage({ id, method, args })
  })
}

/**
 * Routes id-less push messages arriving on a port to prefix-matched handlers.
 * A subscriber to `'fs'` receives both an exact `'fs'` push AND any `'fs.*'`
 * push (e.g. `'fs.changed'`), while a subscriber to `'fs.changed'` matches
 * only that exact type. The leading-segment guard (`startsWith(prefix + '.')`)
 * means `'fsx'` pushes never leak to an `'fs'` subscriber.
 */
export class PushRouter {
  private readonly handlers = new Map<string, Set<PushHandler>>()
  private installed = false

  /** Begin dispatching incoming pushes from `port` (idempotent per router). */
  install(port: MessagePort): void {
    if (this.installed) return
    this.installed = true
    port.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: string } | null
      if (!d || d.id !== undefined || typeof d.type !== 'string') return
      const type = d.type
      for (const [prefix, bucket] of this.handlers) {
        if (type === prefix || type.startsWith(`${prefix}.`)) {
          for (const h of bucket) h(d as PushMessage)
        }
      }
    })
  }

  /**
   * Register `handler` for pushes whose `type` equals or is prefixed by
   * `prefix`. Returns an unsubscribe function that removes exactly this
   * registration.
   */
  subscribe(prefix: string, handler: PushHandler): () => void {
    let bucket = this.handlers.get(prefix)
    if (!bucket) {
      bucket = new Set()
      this.handlers.set(prefix, bucket)
    }
    bucket.add(handler)
    return () => {
      const b = this.handlers.get(prefix)
      if (!b) return
      b.delete(handler)
      if (b.size === 0) this.handlers.delete(prefix)
    }
  }
}
