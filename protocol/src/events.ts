// The canonical event table: the payload of every host -> app push, keyed by
// its `type` string. Pushes are id-less {@link PushMessage}s; the payload below
// is the message minus the `type` field.
//
// Subscription is PREFIX-MATCHED: a subscriber registered for `'fs'` receives
// both an exact `'fs'` push AND any `'fs.*'` push (e.g. `'fs.changed'`).
// Subscribing to the full type (`'fs.changed'`) matches only that exact type.

import type { User } from './data'
import type { AgentEvent } from './methods'

/**
 * The complete push-event map. Keys are the literal `type` strings; each value
 * is the payload that travels alongside `type` in the push message.
 */
export interface EventMap {
  /**
   * A file in the project changed. The host forwards the kernel's FileEvent
   * kind verbatim: `'created' | 'updated' | 'deleted'`.
   */
  'fs.changed': {
    pid: string
    path: string
    kind: 'created' | 'updated' | 'deleted'
  }

  /**
   * A project lifecycle transition. A discriminated union on `kind`. Note
   * `'project:created'` is NOT emitted by `project.create` (which produces no
   * lifecycle push); it is emitted only by the host's pull-on-login
   * materialization. `newName` is present only on `'project:renamed'`. The
   * wire payload is `{ kind, pid }` (plus `newName` where applicable).
   */
  'project.lifecycle':
    | { kind: 'project:opened'; pid: string }
    | { kind: 'project:closed'; pid: string }
    | { kind: 'project:created'; pid: string }
    | { kind: 'project:deleted'; pid: string }
    | { kind: 'project:renamed'; pid: string; newName: string }
    | { kind: 'project:leader-changed'; pid: string }

  /**
   * A local-only project was associated with a canonical projectId (e.g. on the
   * first signed-in server op), so the app can upgrade its URL from the localId
   * to the shareable canonical id. The `pid` (localId) is unchanged;
   * `projectId` is the newly-available canonical id.
   */
  'project.associated': { pid: string; projectId: string }

  /**
   * A project's display name changed (typically because collab sync delivered an
   * updated config). `name` is `null` when the config read transiently yields
   * no name.
   */
  'project.namesChanged': { pid: string; name: string | null }

  /**
   * A project's top-level package.json `description` changed (typically because
   * collab sync delivered an updated config, or `project.setDescription` was
   * called). `description` is `null` when unset. Mirrors `project.namesChanged`.
   */
  'project.descriptionChanged': { pid: string; description: string | null }

  /**
   * @internal A key-value store entry changed (put or delete). Apps normally
   * observe this through the higher-level store helpers rather than subscribing
   * directly. On a delete, `value` is `null` and `deleted` is true.
   */
  'db.change': { store: string; key: string; value: unknown; deleted: boolean }

  /**
   * Authenticated user changed (sign-in, sign-out, identity update). Carries
   * the freshly resolved {@link User}.
   */
  'kernel.authChanged': { user: User }

  /**
   * Coarse publish progress for a `publish.run`. On `'published'`, `canonical`
   * (and possibly `alias`) are set; on `'error'`, `error` carries the message.
   * (These are coarse states, not streamed NDJSON phases.)
   */
  'publish.progress': {
    pid: string
    state: 'publishing' | 'published' | 'error'
    canonical?: string
    alias?: string | null
    error?: string
  }

  /**
   * A streaming text delta from an `ai.chat` or `ai.complete` call made with
   * `stream: true`. Correlated by `requestId` (matches the in-flight RPC id).
   * Deltas are NOT routed through `subscribe()` / `PushRouter` — the streaming
   * layer installs its own `requestId`-filtered listener directly.
   */
  'ai.delta': { requestId: string; delta: string }

  /**
   * @experimental An event push for an active agent session. `seq` is
   * per-session monotonic; consumers detect gaps and recover via `agent.state`.
   * Correlation is by `sessionId`. Note: unlike other events, `agent.event` is
   * NOT namespaced under a project — it correlates to a session, not a file or
   * project lifecycle.
   */
  'agent.event': {
    sessionId: string
    seq: number
    event: AgentEvent
  }
}

/** Every valid push-event `type` string. */
export type Event = keyof EventMap

/** The payload type for a given event. */
export type EventPayload<E extends Event> = EventMap[E]
