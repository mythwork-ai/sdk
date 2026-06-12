// The canonical event table: the payload of every host -> app push, keyed by
// its `type` string. Pushes are id-less {@link PushMessage}s; the payload below
// is the message minus the `type` field. Each shape is verified against its
// emitter in the monorepo (cited inline).
//
// Subscription is PREFIX-MATCHED (verified against the dispatcher in
// packages/orbit-shim-transport/src/index.ts:104-116): a subscriber registered
// for `'fs'` receives both an exact `'fs'` push AND any `'fs.*'` push (e.g.
// `'fs.changed'`). Subscribing to the full type (`'fs.changed'`) matches only
// that exact type.

import type { User } from './data'

/**
 * The complete push-event map. Keys are the literal `type` strings; each value
 * is the payload that travels alongside `type` in the push message.
 */
export interface EventMap {
  /**
   * A file in the project changed. Emitted by the project bridge's filesystem
   * subscription (packages/host-iframe/src/bridges/project.ts:124), which
   * forwards the kernel's FileEvent kind verbatim
   * (packages/orbit-kernel/src/types.ts: 'created' | 'updated' | 'deleted').
   */
  'fs.changed': {
    pid: string
    path: string
    kind: 'created' | 'updated' | 'deleted'
  }

  /**
   * A project lifecycle transition. Emitted from the registry lifecycle
   * callback, forwarded to subscribers (packages/host-iframe/src/db/index.ts:81-83).
   * Note `'project:created'` is NOT emitted by the registry (project.create
   * produces no lifecycle push); it is emitted only by the host's
   * pull-on-login materialization (packages/host-iframe/src/db/index.ts:98,
   * see db/pull-on-login.ts). A discriminated union on `kind`; `newName` is
   * present only on `'project:renamed'`. The host strips any per-tab id
   * before pushing, so the wire payload is just `{ kind, pid }` (+`newName`).
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
   * to the shareable canonical id. Emitted by
   * packages/host-iframe/src/bridges/project.ts:113. The `pid` (localId) is
   * unchanged; `projectId` is the newly-available canonical id.
   */
  'project.associated': { pid: string; projectId: string }

  /**
   * A project's display name changed (typically because collab sync delivered an
   * updated config). Emitted by packages/host-iframe/src/bridges/project.ts:141.
   * `name` is `null` when the config read transiently yields no name.
   */
  'project.namesChanged': { pid: string; name: string | null }

  /**
   * @internal A key-value store entry changed (put or delete). Emitted by
   * packages/host-iframe/src/db/index.ts:307 (and inline on put/delete). Apps
   * normally observe this through the higher-level store helpers rather than
   * subscribing directly. On a delete, `value` is `null` and `deleted` is true.
   */
  'db.change': { store: string; key: string; value: unknown; deleted: boolean }

  /**
   * Authenticated user changed (sign-in, sign-out, identity update). Emitted by
   * the kernel bridge (packages/host-iframe/src/bridges/kernel.ts:219,237) and
   * the auth-change forwarder. Carries the freshly resolved {@link User}.
   */
  'kernel.authChanged': { user: User }

  /**
   * Coarse publish progress for a `publish.run`. Emitted by
   * packages/host-iframe/src/bridges/publish.ts:103,127,131. On `'published'`,
   * `canonical` (and possibly `alias`) are set; on `'error'`, `error` carries
   * the message. (These are coarse states, not streamed NDJSON phases.)
   */
  'publish.progress': {
    pid: string
    state: 'publishing' | 'published' | 'error'
    canonical?: string
    alias?: string | null
    error?: string
  }
}

/** Every valid push-event `type` string. */
export type Event = keyof EventMap

/** The payload type for a given event. */
export type EventPayload<E extends Event> = EventMap[E]
