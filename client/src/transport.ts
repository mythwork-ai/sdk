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
  /**
   * Abort the in-flight call. If already aborted the returned promise rejects
   * synchronously; otherwise an `'abort'` posts `{ id, type: 'cancel' }` to the
   * host, tears down all listeners/timers, and rejects with an `AbortError`.
   */
  signal?: AbortSignal
}

/** Options for {@link streamOverPort}: a {@link RequestOptions} plus a per-delta sink. */
export interface StreamOptions extends RequestOptions {
  /** Invoked with each `ai.delta` text fragment (deltas, not accumulated text). */
  onChunk: (delta: string) => void
}

/** A handler invoked with the full push payload (including its `type` field). */
export type PushHandler = (message: PushMessage) => void

let seq = 0

/**
 * Build the rejection used when an {@link AbortSignal} fires. Prefers the
 * standard `DOMException` (`name === 'AbortError'`), falling back to a plain
 * `Error` so the SDK works in runtimes lacking `DOMException`.
 */
function makeAbortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('aborted', 'AbortError')
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

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
  const signal = opts?.signal
  return new Promise<R>((resolve, reject) => {
    const id = String(seq++)
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
      port.removeEventListener('message', handler)
      signal?.removeEventListener('abort', onAbort)
    }
    const handler = (e: MessageEvent) => {
      const d = e.data as RpcResponse | null
      if (!d || d.id !== id) return
      cleanup()
      if (d.error) reject(new Error(d.error))
      else resolve(d.result as R)
    }
    const onAbort = () => {
      cleanup()
      port.postMessage({ id, type: 'cancel' })
      reject(makeAbortError())
    }
    if (signal) {
      if (signal.aborted) {
        reject(makeAbortError())
        return
      }
      signal.addEventListener('abort', onAbort)
    }
    port.addEventListener('message', handler)
    timer = setTimeout(() => {
      cleanup()
      reject(new Error(`@mythwork/sdk: request "${method}" timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    port.postMessage({ id, method, args })
  })
}

/**
 * Send one streaming RPC over an already-open {@link MessagePort}: post
 * `{ id, method, args: { ...args, stream: true } }`, forward each correlated
 * `ai.delta` push to `opts.onChunk`, and settle on the terminal reply
 * (`{ id, result }` resolves, `{ id, error }` rejects).
 *
 * Two listeners share the port: the reply matcher keys on `d.id === id` (the
 * terminator), while a separate delta listener keys on
 * `d.type === 'ai.delta' && d.requestId === id` — the two are mutually exclusive
 * (a reply has no `type`, a delta has no top-level `id`), so neither leaks into
 * the other. The inactivity timer is re-armed on every delta so a long, healthy
 * stream never trips the base timeout; it only fires after a gap of silence.
 * Every terminal outcome — reply, error, timeout, or abort — clears the timer
 * and removes both listeners plus the abort listener, so nothing leaks.
 */
export function streamOverPort<R = unknown>(
  port: MessagePort,
  method: string,
  args: Record<string, unknown>,
  opts: StreamOptions,
): Promise<R> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const signal = opts.signal
  return new Promise<R>((resolve, reject) => {
    const id = String(seq++)
    let timer: ReturnType<typeof setTimeout> | null = null
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      timer = null
      port.removeEventListener('message', reply)
      port.removeEventListener('message', delta)
      signal?.removeEventListener('abort', onAbort)
    }
    const arm = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        cleanup()
        reject(new Error(`@mythwork/sdk: stream "${method}" timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }
    const reply = (e: MessageEvent) => {
      const d = e.data as RpcResponse | null
      if (!d || d.id !== id) return
      cleanup()
      if (d.error) reject(new Error(d.error))
      else resolve(d.result as R)
    }
    const delta = (e: MessageEvent) => {
      const d = e.data as (PushMessage & { requestId?: string; delta?: string }) | null
      if (!d || d.type !== 'ai.delta' || d.requestId !== id) return
      arm() // reset inactivity timeout on every delta
      opts.onChunk(d.delta ?? '')
    }
    const onAbort = () => {
      cleanup()
      port.postMessage({ id, type: 'cancel' })
      reject(makeAbortError())
    }
    if (signal) {
      if (signal.aborted) {
        reject(makeAbortError())
        return
      }
      signal.addEventListener('abort', onAbort)
    }
    port.addEventListener('message', reply)
    port.addEventListener('message', delta)
    arm()
    port.postMessage({ id, method, args: { ...args, stream: true } })
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
