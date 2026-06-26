// The typed client: a thin, mechanical surface over a live MessagePort. One
// generic `request<M>()` against the protocol's MethodMap, one `subscribe<E>()`
// against its EventMap, and namespaced helpers that map clean names to the
// deployed (sometimes legacy) wire method strings.
//
// Helpers are intentionally dumb: each one forwards its params straight to
// `request()` with the wire method string. No validation, no transformation —
// the protocol types are the contract, the wire is unchanged.

import type {
  AiOpts,
  ChatCompletion,
  ChatMessage,
  Event as ProtocolEvent,
  EventMap,
  EventPayload,
  MethodMap,
  MethodParams,
  MethodResult,
} from '@mythwork/protocol'
import { type PushHandler, PushRouter, type RequestOptions, requestOverPort } from './transport'

/**
 * A subscription target: either a full event `type` (e.g. `'fs.changed'`) for an
 * exact match, or a namespace prefix (e.g. `'fs'`) that also matches every
 * `'fs.*'` event. These are the prefixes the namespaced event helpers use.
 */
export type EventPrefix = 'fs' | 'project' | 'db' | 'kernel' | 'publish' | 'collab'

/** Handler for a typed event subscription; receives the event's full payload. */
export type EventHandler<E extends ProtocolEvent> = (payload: EventPayload<E>) => void

/**
 * The connected client. Construct it via {@link import('./index').connect} (which
 * performs the handshake); this class wraps an already-acquired, started port.
 */
export class MythworkClient {
  /** @internal The live host channel. */
  readonly port: MessagePort
  private readonly router = new PushRouter()

  /**
   * Wrap an already-open, started MessagePort. Prefer `connect()` — it performs
   * the handshake and hands you the port. Use this directly only when you have
   * acquired a port by other means (e.g. tests with a `MessageChannel`).
   */
  constructor(port: MessagePort) {
    this.port = port
    this.router.install(port)
  }

  /**
   * Send a typed RPC request and resolve with the method's result. The `method`
   * is the wire method string; `params` is type-checked against
   * {@link MethodMap}. Rejects with an `Error` carrying the wire error string on
   * an `{ error }` reply, or a timeout error after `opts.timeoutMs` (default
   * {@link import('@mythwork/protocol').DEFAULT_REQUEST_TIMEOUT_MS}).
   */
  request<M extends keyof MethodMap>(
    method: M,
    params: MethodParams<M>,
    opts?: RequestOptions,
  ): Promise<MethodResult<M>> {
    return requestOverPort<MethodResult<M>>(
      this.port,
      method as string,
      params as Record<string, unknown>,
      opts,
    )
  }

  /**
   * Subscribe to host push events. `type` may be a full event type for an exact
   * match (`'fs.changed'`) or a namespace prefix (`'fs'`) that also matches every
   * `'fs.*'` event. The handler receives the full push payload. Returns an
   * unsubscribe function.
   *
   * When `type` is a known event the handler payload is typed precisely; when it
   * is a bare prefix the payload is the union of that namespace's events.
   */
  subscribe<E extends ProtocolEvent>(type: E, handler: EventHandler<E>): () => void
  subscribe(type: EventPrefix, handler: (payload: EventMap[ProtocolEvent]) => void): () => void
  // biome-ignore lint/suspicious/noExplicitAny: implementation widens the
  // handler param so both typed-event and bare-prefix overloads are assignable.
  subscribe(type: string, handler: (payload: any) => void): () => void {
    return this.router.subscribe(type, handler as PushHandler)
  }

  // ── project.* (+ publish.run) ─────────────────────────────────────────────
  /** Project lifecycle and metadata. Maps to `project.*` and `publish.run`. */
  readonly project = {
    /** Create a new local-first project. Wire: `project.create`. */
    create: (params: MethodParams<'project.create'>, opts?: RequestOptions) =>
      this.request('project.create', params, opts),
    /** Open an existing project by id. Wire: `project.open`. */
    open: (params: MethodParams<'project.open'>, opts?: RequestOptions) =>
      this.request('project.open', params, opts),
    /** Close an open project. Wire: `project.close`. */
    close: (params: MethodParams<'project.close'>, opts?: RequestOptions) =>
      this.request('project.close', params, opts),
    /** List known project ids. Wire: `project.list`. */
    list: (params: MethodParams<'project.list'>, opts?: RequestOptions) =>
      this.request('project.list', params, opts),
    /** Permanently delete a project's local data. Wire: `project.delete`. */
    delete: (params: MethodParams<'project.delete'>, opts?: RequestOptions) =>
      this.request('project.delete', params, opts),
    /** Rename a project. Wire: `project.rename`. */
    rename: (params: MethodParams<'project.rename'>, opts?: RequestOptions) =>
      this.request('project.rename', params, opts),
    /** Batch-read project display names. Wire: `project.getNames`. */
    getNames: (params: MethodParams<'project.getNames'>, opts?: RequestOptions) =>
      this.request('project.getNames', params, opts),
    /** Read a project's description. Wire: `project.getDescription`. */
    getDescription: (params: MethodParams<'project.getDescription'>, opts?: RequestOptions) =>
      this.request('project.getDescription', params, opts),
    /** Set a project's description (backs the top-level package.json `description`). Wire: `project.setDescription`. */
    setDescription: (params: MethodParams<'project.setDescription'>, opts?: RequestOptions) =>
      this.request('project.setDescription', params, opts),
    /** Toggle public collaboration on a project. Wire: `project.setPublicCollab`. */
    setPublicCollab: (params: MethodParams<'project.setPublicCollab'>, opts?: RequestOptions) =>
      this.request('project.setPublicCollab', params, opts),
    /** Publish the project's HEAD under a short name. Wire: `publish.run`. */
    publish: (params: MethodParams<'publish.run'>, opts?: RequestOptions) =>
      this.request('publish.run', params, opts),
    /**
     * @experimental Draft surface — not yet served by deployed hosts (explore
     * backend in progress). Fork the app at the source `projectId` (CAS
     * ref-copy of the head tree); resolves the caller's new local handle.
     * Signed-in. Wire: `project.remix`.
     */
    remix: (params: MethodParams<'project.remix'>, opts?: RequestOptions) =>
      this.request('project.remix', params, opts),
    /** Subscribe to project lifecycle transitions. Wire event: `project.lifecycle`. */
    onLifecycle: (handler: EventHandler<'project.lifecycle'>) =>
      this.subscribe('project.lifecycle', handler),
    /** Subscribe to localId→canonical-id association. Wire event: `project.associated`. */
    onAssociated: (handler: EventHandler<'project.associated'>) =>
      this.subscribe('project.associated', handler),
    /** Subscribe to project display-name changes. Wire event: `project.namesChanged`. */
    onNamesChanged: (handler: EventHandler<'project.namesChanged'>) =>
      this.subscribe('project.namesChanged', handler),
    /** Subscribe to project description changes. Wire event: `project.descriptionChanged`. */
    onDescriptionChanged: (handler: EventHandler<'project.descriptionChanged'>) =>
      this.subscribe('project.descriptionChanged', handler),
  }

  // ── fs.* file ops ─────────────────────────────────────────────────────────
  /** Filesystem reads/writes. Maps to `fs.read/write/list/exists/rename/delete`. */
  readonly fs = {
    /** Read a file's bytes. Wire: `fs.read`. */
    read: (params: MethodParams<'fs.read'>, opts?: RequestOptions) =>
      this.request('fs.read', params, opts),
    /** Write a file's bytes. Wire: `fs.write`. */
    write: (params: MethodParams<'fs.write'>, opts?: RequestOptions) =>
      this.request('fs.write', params, opts),
    /** List file paths. Wire: `fs.list`. */
    list: (params: MethodParams<'fs.list'>, opts?: RequestOptions) =>
      this.request('fs.list', params, opts),
    /** Report whether a file exists. Wire: `fs.exists`. */
    exists: (params: MethodParams<'fs.exists'>, opts?: RequestOptions) =>
      this.request('fs.exists', params, opts),
    /** Rename/move a file. Wire: `fs.rename`. */
    rename: (params: MethodParams<'fs.rename'>, opts?: RequestOptions) =>
      this.request('fs.rename', params, opts),
    /** Delete a file. Wire: `fs.delete`. */
    delete: (params: MethodParams<'fs.delete'>, opts?: RequestOptions) =>
      this.request('fs.delete', params, opts),
    /** Subscribe to file changes. Wire event: `fs.changed`. */
    onChanged: (handler: EventHandler<'fs.changed'>) => this.subscribe('fs.changed', handler),
  }

  // ── git ops (wire fs.*) ───────────────────────────────────────────────────
  /**
   * Version-control operations. These share the `fs.*` wire prefix but route to
   * the host's git bridge, hence a distinct client namespace.
   */
  readonly git = {
    /** Commit the working tree. Wire: `fs.commit`. */
    commit: (params: MethodParams<'fs.commit'>, opts?: RequestOptions) =>
      this.request('fs.commit', params, opts),
    /** Read commit history (newest first). Wire: `fs.log`. */
    log: (params: MethodParams<'fs.log'>, opts?: RequestOptions) =>
      this.request('fs.log', params, opts),
    /** Read a file's bytes at a revision. Wire: `fs.showVersion`. */
    showVersion: (params: MethodParams<'fs.showVersion'>, opts?: RequestOptions) =>
      this.request('fs.showVersion', params, opts),
    /** Structured working-tree diff. Wire: `fs.diff`. */
    diff: (params: MethodParams<'fs.diff'>, opts?: RequestOptions) =>
      this.request('fs.diff', params, opts),
    /** Check out a revision. Wire: `fs.checkout`. */
    checkout: (params: MethodParams<'fs.checkout'>, opts?: RequestOptions) =>
      this.request('fs.checkout', params, opts),
    /** Current HEAD sha (or null). Wire: `fs.head`. */
    head: (params: MethodParams<'fs.head'>, opts?: RequestOptions) =>
      this.request('fs.head', params, opts),
    /** Whether the working tree is dirty. Wire: `fs.hasUncommittedChanges`. */
    hasUncommittedChanges: (
      params: MethodParams<'fs.hasUncommittedChanges'>,
      opts?: RequestOptions,
    ) => this.request('fs.hasUncommittedChanges', params, opts),
    /** Copy a source commit's tree forward as a new commit. Wire: `fs.commitTree`. */
    commitTree: (params: MethodParams<'fs.commitTree'>, opts?: RequestOptions) =>
      this.request('fs.commitTree', params, opts),
    /** Rewrite history to drop a commit. Wire: `fs.deleteCommit`. */
    deleteCommit: (params: MethodParams<'fs.deleteCommit'>, opts?: RequestOptions) =>
      this.request('fs.deleteCommit', params, opts),
    /** Rewrite a commit's message. Wire: `fs.editCommitMessage`. */
    editCommitMessage: (params: MethodParams<'fs.editCommitMessage'>, opts?: RequestOptions) =>
      this.request('fs.editCommitMessage', params, opts),
    /** Flush dirty in-memory docs to the filesystem. Wire: `fs.flushDirty`. */
    flushDirty: (params: MethodParams<'fs.flushDirty'>, opts?: RequestOptions) =>
      this.request('fs.flushDirty', params, opts),
  }

  // ── collab.* ──────────────────────────────────────────────────────────────
  /** Collaborative-room resolution. Maps to `collab.*`. */
  readonly collab = {
    /** Resolve a collaborative room for the project. Wire: `collab.openRoom`. */
    openRoom: (params: MethodParams<'collab.openRoom'>, opts?: RequestOptions) =>
      this.request('collab.openRoom', params, opts),
  }

  // ── store (wire db.*) ─────────────────────────────────────────────────────
  /**
   * @internal Key-value store. Maps to `db.*`. Apps normally reach this through
   * higher-level store helpers rather than calling directly.
   */
  readonly store = {
    /** @internal Put a value under `(store, key)`. Wire: `db.put`. */
    put: (params: MethodParams<'db.put'>, opts?: RequestOptions) =>
      this.request('db.put', params, opts),
    /** @internal Get the value at `(store, key)`. Wire: `db.get`. */
    get: (params: MethodParams<'db.get'>, opts?: RequestOptions) =>
      this.request('db.get', params, opts),
    /** @internal Get every entry in a store. Wire: `db.getAll`. */
    getAll: (params: MethodParams<'db.getAll'>, opts?: RequestOptions) =>
      this.request('db.getAll', params, opts),
    /** @internal Delete the value at `(store, key)`. Wire: `db.delete`. */
    delete: (params: MethodParams<'db.delete'>, opts?: RequestOptions) =>
      this.request('db.delete', params, opts),
    /** @internal Force a cloud-sync flush. Wire: `db.sync`. */
    sync: (params: MethodParams<'db.sync'>, opts?: RequestOptions) =>
      this.request('db.sync', params, opts),
    /** @internal Subscribe to store entry changes. Wire event: `db.change`. */
    onChange: (handler: EventHandler<'db.change'>) => this.subscribe('db.change', handler),
  }

  // ── ydocs.* ───────────────────────────────────────────────────────────────
  /**
   * @internal Yjs update-log persistence. Maps to `ydocs.*`. Apps normally use
   * the y-indexeddb shim rather than calling these directly.
   */
  readonly ydocs = {
    /** @internal Append a Yjs update. Wire: `ydocs.append`. */
    append: (params: MethodParams<'ydocs.append'>, opts?: RequestOptions) =>
      this.request('ydocs.append', params, opts),
    /** @internal Read every stored update for a doc. Wire: `ydocs.getAll`. */
    getAll: (params: MethodParams<'ydocs.getAll'>, opts?: RequestOptions) =>
      this.request('ydocs.getAll', params, opts),
    /** @internal Replace a doc's log with a compacted snapshot. Wire: `ydocs.snapshot`. */
    snapshot: (params: MethodParams<'ydocs.snapshot'>, opts?: RequestOptions) =>
      this.request('ydocs.snapshot', params, opts),
    /** @internal Drop a doc's update store. Wire: `ydocs.clear`. */
    clear: (params: MethodParams<'ydocs.clear'>, opts?: RequestOptions) =>
      this.request('ydocs.clear', params, opts),
  }

  // ── auth (wire kernel.*) ──────────────────────────────────────────────────
  /** Authentication and identity. Maps to `kernel.*`. */
  readonly auth = {
    /** Resolve the current user (anonymous sentinel when signed out). Wire: `kernel.getUser`. */
    getUser: (params: MethodParams<'kernel.getUser'> = {}, opts?: RequestOptions) =>
      this.request('kernel.getUser', params, opts),
    /** Sign in (opens the OAuth popup if needed). Wire: `kernel.signIn`. */
    signIn: (params: MethodParams<'kernel.signIn'> = {}, opts?: RequestOptions) =>
      this.request('kernel.signIn', params, opts),
    /** Sign out the platform session. Wire: `kernel.signOut`. */
    signOut: (params: MethodParams<'kernel.signOut'> = {}, opts?: RequestOptions) =>
      this.request('kernel.signOut', params, opts),
    /** Subscribe to authenticated-user changes. Wire event: `kernel.authChanged`. */
    onAuthChanged: (handler: EventHandler<'kernel.authChanged'>) =>
      this.subscribe('kernel.authChanged', handler),
  }

  // ── secrets.* ─────────────────────────────────────────────────────────────
  /** Server-managed secrets. Maps to `secrets.*`. */
  readonly secrets = {
    /** Report whether a named secret is set (never reveals it). Wire: `secrets.check`. */
    check: (params: MethodParams<'secrets.check'>, opts?: RequestOptions) =>
      this.request('secrets.check', params, opts),
    /** Proxy an HTTPS request with `{{SECRET}}` substitution at the edge. Wire: `secrets.proxyFetch`. */
    proxyFetch: (params: MethodParams<'secrets.proxyFetch'>, opts?: RequestOptions) =>
      this.request('secrets.proxyFetch', params, opts),
  }

  // ── config.* ──────────────────────────────────────────────────────────────
  /** Project configuration. Maps to `config.get`. */
  readonly config = {
    /** Read the project's parsed config. Wire: `config.get`. */
    get: (params: MethodParams<'config.get'>, opts?: RequestOptions) =>
      this.request('config.get', params, opts),
  }

  // ── profile.* ─────────────────────────────────────────────────────────────
  /** Creator-profile reads and consent-gated mutations. Maps to `profile.*`. */
  readonly profile = {
    /** Public read of a creator profile by handle. Wire: `profile.get`. */
    get: (params: MethodParams<'profile.get'>, opts?: RequestOptions) =>
      this.request('profile.get', params, opts),
    /** Public read of the discovery landing. Wire: `profile.discover`. */
    discover: (params: MethodParams<'profile.discover'> = {}, opts?: RequestOptions) =>
      this.request('profile.discover', params, opts),
    /** Consent-gated: claim a profile handle. Wire: `profile.claimHandle`. */
    claimHandle: (params: MethodParams<'profile.claimHandle'>, opts?: RequestOptions) =>
      this.request('profile.claimHandle', params, opts),
    /** Consent-gated: link a content subproject. Wire: `profile.setContentProject`. */
    setContentProject: (params: MethodParams<'profile.setContentProject'>, opts?: RequestOptions) =>
      this.request('profile.setContentProject', params, opts),
    /** Consent-gated: publish profile content under a handle. Wire: `profile.publish`. */
    publish: (params: MethodParams<'profile.publish'>, opts?: RequestOptions) =>
      this.request('profile.publish', params, opts),
    /** Toggle the viewer's favorite of a creator or app. Wire: `profile.setFavorite`. */
    setFavorite: (params: MethodParams<'profile.setFavorite'>, opts?: RequestOptions) =>
      this.request('profile.setFavorite', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. The signed-in viewer's
     * OWN profile resolved server-side from the session (no handle derivation).
     * Signed-out resolves `{ ok: false, reason: 'sign_in_required' }` with
     * zero network; unclaimed resolves `{ ok: false, reason: 'no_profile' }`.
     * Discriminate on `'reason' in result`. Wire: `profile.me`.
     */
    me: (opts?: RequestOptions) => this.request('profile.me', {}, opts),
    /**
     * @experimental — API may still evolve before 1.0. The viewer's
     * favorites/follows, optionally filtered by `targetKind`. Signed-in.
     * Wire: `profile.myFavorites`.
     */
    myFavorites: (params: MethodParams<'profile.myFavorites'> = {}, opts?: RequestOptions) =>
      this.request('profile.myFavorites', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Update the viewer's
     * structured profile fields (server owns link normalization). Signed-in.
     * Wire: `profile.update`.
     */
    update: (params: MethodParams<'profile.update'>, opts?: RequestOptions) =>
      this.request('profile.update', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Read the viewer's
     * notification preferences. Signed-in.
     * Wire: `profile.getNotificationPrefs`.
     */
    getNotificationPrefs: (
      params: MethodParams<'profile.getNotificationPrefs'> = {},
      opts?: RequestOptions,
    ) => this.request('profile.getNotificationPrefs', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Update some notification
     * preferences; returns the full updated prefs. Signed-in.
     * Wire: `profile.setNotificationPrefs`.
     */
    setNotificationPrefs: (
      params: MethodParams<'profile.setNotificationPrefs'>,
      opts?: RequestOptions,
    ) => this.request('profile.setNotificationPrefs', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Submit the full authed
     * claim (lead fields + the real platform handle + opaque `survey` blob).
     * Signed-out resolves `{ ok: false, reason: 'sign_in_required' }` with zero
     * network — render the not-saved state, run `auth.signIn()`, and retry once.
     * Wire: `profile.submitClaim`.
     */
    submitClaim: (params: MethodParams<'profile.submitClaim'>, opts?: RequestOptions) =>
      this.request('profile.submitClaim', params, opts),
    /**
     * @experimental — record that an approved user accepted their invite.
     * Best-effort: callers should not block UI on it. Wire: `profile.acceptInvite`.
     */
    acceptInvite: (params: MethodParams<'profile.acceptInvite'> = {}, opts?: RequestOptions) =>
      this.request('profile.acceptInvite', params, opts),
  }

  // ── explore.* ────────────────────────────────────────────────────────────
  /**
   * @experimental — API may still evolve before 1.0. Discovery and engagement
   * reads/writes. Maps to `explore.*`. Reads are public/anonymous-OK; rate,
   * clearRating, myRatings, and addComment are sign-in gated host-side.
   * Discovery operates on canonical project ids (param `projectId`).
   */
  readonly explore = {
    /**
     * @experimental — API may still evolve before 1.0. List apps for discovery,
     * filtered/sorted/paginated. Wire: `explore.listApps`.
     */
    listApps: (params: MethodParams<'explore.listApps'> = {}, opts?: RequestOptions) =>
      this.request('explore.listApps', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Read one app's full
     * detail by `projectId`. Wire: `explore.getApp`.
     */
    getApp: (params: MethodParams<'explore.getApp'>, opts?: RequestOptions) =>
      this.request('explore.getApp', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Apps related to the
     * given `projectId`. Wire: `explore.relatedApps`.
     */
    relatedApps: (params: MethodParams<'explore.relatedApps'>, opts?: RequestOptions) =>
      this.request('explore.relatedApps', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. The trending rail.
     * Wire: `explore.trendingApps`.
     */
    trendingApps: (params: MethodParams<'explore.trendingApps'> = {}, opts?: RequestOptions) =>
      this.request('explore.trendingApps', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Every tag with its app
     * count. Wire: `explore.tags`.
     */
    tags: (params: MethodParams<'explore.tags'> = {}, opts?: RequestOptions) =>
      this.request('explore.tags', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Search apps and makers
     * by `q` (supports `@handle` / `#tag`). Wire: `explore.search`.
     */
    search: (params: MethodParams<'explore.search'>, opts?: RequestOptions) =>
      this.request('explore.search', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. The seeded popular
     * search terms. Wire: `explore.popularSearches`.
     */
    popularSearches: (
      params: MethodParams<'explore.popularSearches'> = {},
      opts?: RequestOptions,
    ) => this.request('explore.popularSearches', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. The editorial spotlight
     * slot. Wire: `explore.spotlight`.
     */
    spotlight: (params: MethodParams<'explore.spotlight'> = {}, opts?: RequestOptions) =>
      this.request('explore.spotlight', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. The editorial
     * collections list. Wire: `explore.collections`.
     */
    collections: (params: MethodParams<'explore.collections'> = {}, opts?: RequestOptions) =>
      this.request('explore.collections', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Rate an app 1–5 stars.
     * Signed-in. Wire: `explore.rate`.
     */
    rate: (params: MethodParams<'explore.rate'>, opts?: RequestOptions) =>
      this.request('explore.rate', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Clear the viewer's
     * rating on an app. Signed-in. Wire: `explore.clearRating`.
     */
    clearRating: (params: MethodParams<'explore.clearRating'>, opts?: RequestOptions) =>
      this.request('explore.clearRating', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. The viewer's ratings
     * (projectId → stars). Signed-in. Wire: `explore.myRatings`.
     */
    myRatings: (params: MethodParams<'explore.myRatings'> = {}, opts?: RequestOptions) =>
      this.request('explore.myRatings', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. An app's comments,
     * newest first, paginated. Wire: `explore.comments`.
     */
    comments: (params: MethodParams<'explore.comments'>, opts?: RequestOptions) =>
      this.request('explore.comments', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Add a comment or reply
     * (`parentCommentId`). Signed-in. Wire: `explore.addComment`.
     */
    addComment: (params: MethodParams<'explore.addComment'>, opts?: RequestOptions) =>
      this.request('explore.addComment', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Owner-update an app's editable
     * metadata (`name`/`tagline`/`note`); the override layers over the
     * publish-derived fields and survives republish. Owner-gated; signed-out
     * resolves `{ ok: false, reason: 'sign_in_required' }`.
     * Wire: `explore.updateAppMeta`.
     */
    updateAppMeta: (params: MethodParams<'explore.updateAppMeta'>, opts?: RequestOptions) =>
      this.request('explore.updateAppMeta', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Owner-unpublish the app at the
     * canonical `projectId`. Reversible: removes the published site without
     * deleting the project. Owner-gated; signed-out resolves
     * `{ ok: false, reason: 'sign_in_required' }`.
     * Wire: `explore.unpublish`.
     */
    unpublish: (params: MethodParams<'explore.unpublish'>, opts?: RequestOptions) =>
      this.request('explore.unpublish', params, opts),
    /**
     * @experimental — API may still evolve before 1.0. Owner-delete the app at the
     * canonical `projectId`: unpublishes then soft-deletes the project row.
     * Owner-gated; if the unpublish step hard-fails, the project row is NOT
     * deleted (no half-delete). Signed-out resolves
     * `{ ok: false, reason: 'sign_in_required' }`.
     * Wire: `explore.deleteApp`.
     */
    deleteApp: (params: MethodParams<'explore.deleteApp'>, opts?: RequestOptions) =>
      this.request('explore.deleteApp', params, opts),
  }

  // ── ai.* (mythwork-ai proxy) ──────────────────────────────────────────────
  /**
   * @experimental — API may still evolve before 1.0. AI completions via the
   * `mythwork-ai` proxy. Sign-in required: the host attaches its own session
   * Bearer and the call REJECTS (`'sign in required'`) when signed out, on a
   * stale token, out of credits (`'… out of credits'`), or rate-limited
   * (`'… rate limited'`). Maps to `ai.chat` / `ai.complete`.
   *
   * v1 is NON-streaming — `ai.chat` resolves the full assistant message rather
   * than an async iterable of deltas. TODO(stream): a streaming variant is a
   * fast-follow once the bridge transport carries correlated chunk pushes.
   */
  readonly ai = {
    /**
     * @experimental Multi-turn chat. Resolves the assistant {@link ChatMessage}
     * (the first choice's message). `opts` are the OpenAI knobs. Wire: `ai.chat`.
     */
    chat: async (
      messages: ChatMessage[],
      opts?: AiOpts,
      reqOpts?: RequestOptions,
    ): Promise<ChatMessage> => {
      const completion = await this.request(
        'ai.chat',
        { messages, ...aiWireOpts(opts) } as MethodParams<'ai.chat'>,
        reqOpts,
      )
      return assistantMessage(completion)
    },
    /**
     * @experimental Single-prompt convenience. Resolves the assistant text (the
     * first choice's `message.content` as a string). `opts` are the OpenAI
     * knobs. Wire: `ai.complete`.
     */
    complete: async (prompt: string, opts?: AiOpts, reqOpts?: RequestOptions): Promise<string> => {
      const completion = await this.request(
        'ai.complete',
        { prompt, ...aiWireOpts(opts) } as MethodParams<'ai.complete'>,
        reqOpts,
      )
      const content = assistantMessage(completion).content
      return typeof content === 'string' ? content : ''
    },
  }
}

/**
 * Map the app-facing camelCase {@link AiOpts} onto the snake_case OpenAI wire
 * fields the `mythwork-ai` worker expects (`maxTokens` → `max_tokens`, etc.).
 * Only present keys are emitted so the worker applies its own defaults.
 */
function aiWireOpts(opts?: AiOpts): Record<string, unknown> {
  if (!opts) return {}
  const out: Record<string, unknown> = {}
  if (opts.model !== undefined) out.model = opts.model
  if (opts.system !== undefined) out.system = opts.system
  if (opts.maxTokens !== undefined) out.max_tokens = opts.maxTokens
  if (opts.temperature !== undefined) out.temperature = opts.temperature
  if (opts.topP !== undefined) out.top_p = opts.topP
  if (opts.tools !== undefined) out.tools = opts.tools
  if (opts.toolChoice !== undefined) out.tool_choice = opts.toolChoice
  if (opts.thinking !== undefined) out.thinking = opts.thinking
  return out
}

/** The assistant message from the first choice of a normalized completion. */
function assistantMessage(completion: ChatCompletion): ChatMessage {
  const message = completion.choices?.[0]?.message
  if (!message) throw new Error('@mythwork/sdk: ai response had no choices')
  return message
}
