// @mythwork/sdk/react — single-prompt streaming completion hook. Wraps
// sdk.ai.complete with onChunk to stream deltas into React state. Each call
// to complete() owns a fresh AbortController; stop() cancels it. The controller
// is also aborted on unmount to prevent state updates on dead trees.
//
// Usage:
//   const { complete, text, isStreaming, error, stop } = useCompletion()
//   const result = await complete('Write me a haiku')

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiOpts } from '@mythwork/protocol'
import { useMythwork } from './platform'

export function useCompletion(): {
  complete: (prompt: string, opts?: AiOpts & { signal?: AbortSignal }) => Promise<string>
  text: string
  isStreaming: boolean
  error: Error | null
  stop: () => void
} {
  const { sdk } = useMythwork()
  const [text, setText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  // Abort any in-flight stream on unmount to avoid state updates on dead trees.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort()
    }
  }, [])

  /** Cancel the current in-flight completion. A user-initiated stop is NOT
   *  surfaced as an error — the hook's `error` state remains null. */
  const stop = useCallback(() => {
    controllerRef.current?.abort()
  }, [])

  const complete = useCallback(
    async (prompt: string, opts?: AiOpts & { signal?: AbortSignal }): Promise<string> => {
      if (!sdk) throw new Error('@mythwork/sdk: useCompletion — SDK not yet connected')

      // Cancel any previous in-flight call and mint a fresh controller.
      controllerRef.current?.abort()
      const controller = new AbortController()
      controllerRef.current = controller

      // Forward an external caller signal into our internal controller so that
      // effect-cleanup patterns (e.g. React 18 strict-mode double-invoke) work
      // without bypassing stop()'s controller ref.
      const { signal: externalSignal, ...restOpts } = opts ?? {}
      let externalAbortListener: (() => void) | undefined
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort()
        } else {
          externalAbortListener = () => controller.abort()
          externalSignal.addEventListener('abort', externalAbortListener, { once: true })
        }
      }

      setText('')
      setIsStreaming(true)
      setError(null)

      try {
        const result = await sdk.ai.complete(
          prompt,
          {
            ...restOpts,
            // Guard: only append deltas for the call that currently owns the ref.
            // An older superseded call can still receive onChunk callbacks after
            // its abort; without this guard those deltas corrupt the newer call's
            // accumulated text.
            onChunk: delta => {
              if (controllerRef.current === controller) setText(t => t + delta)
            },
          },
          { signal: controller.signal },
        )
        // Only mutate state if this call is still the current one. A newer
        // call has already reset text/isStreaming for itself; letting an older
        // settled call overwrite those would clobber the newer call's state.
        if (controllerRef.current === controller) {
          // Overwrite with the authoritative full string (guards against any delta
          // delivery skew while also providing the correct value on non-streaming
          // fallback paths).
          setText(result)
          setIsStreaming(false)
        }
        return result
      } catch (err) {
        if (controllerRef.current === controller) {
          setIsStreaming(false)
        }
        // A user-initiated stop (stop() or externalSignal.abort()) is not an
        // error — leave error state null and re-throw so callers can catch if needed.
        // Name-only check: works for both Error subclasses and DOMException, which
        // may not extend Error in all environments.
        if ((err as { name?: string })?.name === 'AbortError') throw err
        const e = err instanceof Error ? err : new Error(String(err))
        if (controllerRef.current === controller) {
          setError(e)
        }
        throw e
      } finally {
        // Remove the external-signal listener when the call settles (success,
        // abort, or error) to avoid holding a reference to the internal controller
        // past its lifetime. No-op if the signal already fired (once auto-removes).
        if (externalAbortListener) {
          externalSignal!.removeEventListener('abort', externalAbortListener)
        }
      }
    },
    [sdk],
  )

  return { complete, text, isStreaming, error, stop }
}
