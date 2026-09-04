// The canonical method table: one entry per wire method, each declaring its
// `params` (the request `args`) and `result` (the response `result`). This IS
// the contract — the client is mechanical on top of it. Every shape is
// verified against the host bridge it maps to.
//
// Wire method strings keep their deployed names even where they leak old
// naming (`kernel.getUser`, `db.get`, git ops under `fs.*`); the client maps
// these to clean namespaces.

import type {
  AppDetail,
  AppSort,
  AppSummary,
  ChatCompletion,
  ChatMessage,
  CollectionInfo,
  CommentNode,
  CommitAuthor,
  CommitInfo,
  DiffEntry,
  FavoriteEdge,
  MakerRef,
  MakerSummary,
  MyAppSummary,
  NotificationInboxItem,
  NotificationPrefs,
  Ok,
  OpenAITool,
  ProjectConfig,
  ProjectInfo,
  RoomDescriptor,
  SharedAppSummary,
  SharedStack,
  SpotlightItem,
  StackKind,
  StackSummary,
  StackVisibility,
  TagCount,
  User,
  UserAccess,
} from './data'

/**
 * @experimental Shared `opts` for the `ai.*` methods — the OpenAI-compatible
 * knobs an app may set per call. Omitted fields default proxy-side. These map
 * 1:1 onto the worker's {@link import('./data').ChatCompletionRequest} (the
 * bridge forwards them verbatim); `maxTokens` is the only camelCase rename
 * (→ `max_tokens`) so the app surface reads idiomatically.
 */
interface AiOptsBase {
  model?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  tools?: OpenAITool[]
  toolChoice?: unknown
  thinking?: boolean
  // client-only; presence enables streaming (never serialized to the wire)
  onChunk?: (delta: string) => void
}

/**
 * @experimental Shared `opts` for the `ai.*` methods. The system-prompt slot is
 * filled EITHER by an inline `system` string OR by a `systemPreset` name (a
 * server-stored preset resolved to `system` bridge-side) — never both. The
 * `?: never` arms make a both-fields object a type error; the bridge also
 * throws at runtime as a backstop for plain-JS callers.
 *
 * There is no `projectId` field: a `systemPreset` resolves against the running
 * app's OWN project, whose canonical id the host frame derives from its trusted
 * current-project context (never a client arg — Correction A / security).
 */
export type AiOpts =
  | (AiOptsBase & { system?: string; systemPreset?: never })
  | (AiOptsBase & { system?: never; systemPreset?: string })

/**
 * @experimental What `ai.build` resolves to: the URL of the running preview and
 * the id of the build job that produced it. The job keeps running after this
 * resolves — see {@link import('./methods').MethodMap} `'ai.build'`.
 */
export interface BuildResult {
  previewUrl: string
  jobId: string
}

/**
 * @experimental One progress tick of an `ai.build` job, JSON-encoded into the
 * `delta` of each correlated `ai.delta` push. `componentsDone`/`componentsTotal`
 * describe the current stage's component fan-out; `component` names the one
 * being worked on when the tick is component-scoped.
 */
export interface BuildProgress {
  stage: string
  componentsTotal: number
  componentsDone: number
  component?: string
}

/**
 * @experimental `opts` for the `@mythwork/sdk` `ai.build` helper.
 *
 * `projectId` names the project to build INTO and is required — see the
 * `'ai.build'` entry in {@link MethodMap} for why it is a caller argument rather
 * than the host's own current project. `onProgress` is client-only (never
 * serialized): passing it is what makes the helper take the streaming path and
 * set `stream: true` on the outbound args.
 */
export interface BuildOpts {
  projectId: string
  onProgress?: (progress: BuildProgress) => void
}

/**
 * @experimental The reasons an `agent.*` call may fail as a gated RESULT (rather
 * than a thrown error):
 *   - `sign_in_required`      — signed out (enforced bridge-local, zero network).
 *   - `turn_in_progress`      — a turn already holds the (shared) loop.
 *   - `session_limit`         — the per-shell session cap is reached.
 *   - `unknown_session`       — no session for the given id.
 *   - `unknown_question`      — `agent.answer` id does not match the session's
 *                               pending `question` event.
 *   - `custom_tools_unsupported` — v1 rejects client `tools` declarations.
 */
export type AgentGatedReason =
  | 'sign_in_required'
  | 'turn_in_progress'
  | 'session_limit'
  | 'unknown_session'
  | 'unknown_question'
  | 'custom_tools_unsupported'

/**
 * @experimental Gated-result failure envelope returned as a result value rather
 * than a thrown error. Used by `agent.*` for the precondition failures above.
 */
export type GatedResult = { ok: false; reason: AgentGatedReason }

/**
 * @experimental Options for opening a new agent session. All fields are
 * optional; the host resolves defaults server-side.
 *
 * - `persona`: named persona preset (resolved server-side, never bundled).
 * - `variant`: variant of the persona (e.g. `'concise'`, `'creative'`). `'design'`
 *   is host-selected from the user's Fast/Design choice and is IGNORED here — an
 *   app cannot opt itself into the expensive design prompt.
 * - `model`: override the default LLM model.
 * - `toolset`: named toolset restricts which tools the agent may call.
 * - `instructions`: bounded inline instruction appended last (≤2 KB).
 * - `tools`: custom tool declarations — v1 rejects with `custom_tools_unsupported`.
 */
export interface AgentSessionOptions {
  persona?: string
  variant?: string
  model?: string
  toolset?: string
  instructions?: string
  tools?: unknown[]
  // NOTE: there is deliberately NO `designUpgrade` here, and it must not come back.
  // It was added as a per-session force and that was a hole: `agent.*` is reachable
  // from the sandboxed app iframe (router.ts routes the prefix and passes
  // `envelope.args` through), the app is MODEL-AUTHORED code, and the field sat at
  // rank 1 of the resolution order — so a generated app could pin the gate on with
  // `agent.create({ designUpgrade: true })`, outranking the user's own choice. It
  // was also a small credit-amplification vector, since the gate spends extra
  // model rounds against the signed-in user's balance.
  //
  // The two legitimate producers are both host-side and stay there: the dev hosts set
  // `HostFrameConfig.designUpgrade` (a trusted host config, not an app param) which
  // becomes the host DEFAULT, and tests pass the internal `explicit` argument to
  // resolveDesignUpgradeDecision directly.
}

/**
 * @experimental The union of all events the host may push for an agent session.
 * `kind` is the discriminant.
 *
 * Protocol law:
 * - `turn-done` is the ONLY terminal signal. `error` carries `fatal` and NEVER
 *   terminates a turn by itself.
 * - `cycle-start` bounds bubble segments so post-tool text cannot collapse into
 *   a pre-tool bubble.
 * - `tool-start` carries display facts only — never raw args.
 */
export type AgentEvent =
  | { kind: 'turn-start'; turnId: string }
  | { kind: 'cycle-start'; cycle: number }
  | { kind: 'text-delta'; delta: string }
  | { kind: 'text-done'; text: string }
  | { kind: 'tool-start'; toolCallId: string; tool: string; detail?: Record<string, unknown> }
  | {
      kind: 'tool-result'
      toolCallId: string
      ok: boolean
      summary?: string
      filesChanged?: string[]
    }
  | { kind: 'question'; questionId: string; questions: { question: string; options: string[] }[] }
  | { kind: 'changes'; files: string[]; checkpoint?: string }
  | {
      kind: 'error'
      message: string
      fatal: boolean
      reason?:
        | 'credits'
        /** Transient: too many requests in a row. Retrying shortly works. */
        | 'rate_limit'
        /**
         * A DAILY spend cap (this person's or the platform's), which resets at
         * midnight UTC. Distinct from `rate_limit` because the recovery is
         * different by a factor of hours, and describing it as "give it a
         * moment" is the failure — the cap is checked per request, so it trips
         * mid-build on a build that cannot resume until tomorrow.
         */
        | 'daily_cap'
        | 'sign_in'
        | 'aborted'
        | 'internal'
        | 'truncated'
    }
  | { kind: 'turn-done'; turnId: string; status: 'ok' | 'stopped' | 'error' }
  | { kind: 'usage'; promptTokens?: number; completionTokens?: number; costUsd?: number }
  | { kind: 'tool-request'; requestId: string; tool: string; args: unknown }

/**
 * @experimental The push-message envelope for agent session events.
 * `seq` is per-session monotonic; consumers detect gaps and recover via
 * `agent.state`. Correlation is by `sessionId`, not `requestId`.
 */
export type AgentEventPush = {
  type: 'agent.event'
  sessionId: string
  seq: number
  event: AgentEvent
}

/**
 * @experimental Session lifecycle state for `agent.state`. Narrows the `status`
 * result field to the exhaustive set returned by the platform.
 */
export type AgentSessionStatus = 'idle' | 'active'

/**
 * Result of the profile mutations: the host either returns the server JSON on
 * success or a `{ ok: false; reason }` shape it maps from an error status
 * (consent denied, conflict, forbidden, …) without throwing, so the app can
 * render the appropriate affordance. The success branch is intentionally open —
 * the underlying server JSON is not strongly typed at the wire boundary.
 */
export type ProfileMutationResult =
  | { ok: false; reason: string }
  | (Record<string, unknown> & { ok?: true })

/**
 * Whether the publisher showed the server it holds the published tree's bytes.
 *
 * Only a proven publish opens source reads (pull / eject) on the tree. A tree
 * nobody else has published is proven without a challenge; a claim on bytes
 * someone else published first needs one answered.
 */
export type PossessionOutcome = { proven: true } | { proven: false; reason: string }

/**
 * The complete wire method map. Keys are the literal method strings; each value
 * declares the request `params` and the response `result`.
 */
export interface MethodMap {
  // ── project.* ───────────────────────────────────────────────────────────

  /**
   * Create a new project; the host draws a pooled canonical id server-side (zero
   * network). `projectName` seeds the display name; `parentProjectId` encodes a
   * parent for collab-server indexing. `open` takes an existing canonical id.
   */
  'project.create': {
    params: { projectName?: string; parentProjectId?: string }
    result: ProjectInfo
  }
  /**
   * Open an existing project by its canonical id. The returned `pid` is the
   * local registry key (same as the canonical id in the single-canonical-id model).
   */
  'project.open': { params: { pid: string }; result: ProjectInfo }
  /** Close an open project, draining its resources and registry tracking entry. */
  'project.close': { params: { pid: string }; result: Ok }
  /** List the ids of all projects this device knows about. */
  'project.list': { params: Record<string, never>; result: { pids: string[] } }
  /** Permanently delete a project's local data. */
  'project.delete': { params: { pid: string }; result: Ok }
  /** Rename a project (updates the on-disk config + name cache). */
  'project.rename': { params: { pid: string; newName: string }; result: Ok }
  /**
   * Read a single project's display name (cached). `null` means the config
   * isn't on disk yet (e.g. a pull-on-login materialization in flight).
   */
  'project.getName': { params: { pid: string }; result: { name: string | null } }
  /** Batched {@link MethodMap['project.getName']} — one round-trip for a list. */
  'project.getNames': {
    params: { pids: string[] }
    result: { names: Record<string, string | null> }
  }
  /**
   * Read a project's top-level package.json `description` (cached). `null` when
   * the app has no description or the config isn't on disk yet. Mirrors
   * {@link MethodMap['project.getName']}.
   */
  'project.getDescription': { params: { pid: string }; result: { description: string | null } }
  /**
   * Set a project's top-level package.json `description` (the standard npm
   * field, NOT the `mythwork` display block); the rest of package.json is
   * preserved. An empty string clears it. The value is indexed for explore
   * search on the next publish (the platform caps it at 4096 chars). Mirrors
   * {@link MethodMap['project.rename']}. Wire: `project.setDescription`.
   */
  'project.setDescription': { params: { pid: string; description: string }; result: Ok }
  /**
   * Toggle public collaboration on a project. Requires a signed-in session
   * (the host first ensures a canonical projectId, then calls the owner-only
   * setter); a local-only/anonymous project rejects.
   */
  'project.setPublicCollab': {
    params: { pid: string; enabled: boolean }
    result: { projectId: string; publicCollab: boolean }
  }
  /**
   * Fork the app at the source canonical `projectId`: a CAS ref-copy of that
   * app's PUBLISHED tree closure (refcount bump, zero data copy) into a fresh
   * project the caller owns, born at a synthesized PARENTLESS commit over that
   * tree — not the source's live editing head or its commit history, which
   * may hold unpublished work and would otherwise make retention unbounded.
   * Signed-in. Returns the caller's new local project handle ({@link
   * ProjectInfo}: `{ pid, role }`).
   */
  'project.remix': { params: { projectId: string }; result: ProjectInfo }

  // ── fs.* file ops ───────────────────────────────────────────────────────

  /** Read a file's bytes. Rejects if the file does not exist. */
  'fs.read': { params: { pid: string; path: string }; result: Uint8Array }
  /** Write a file's bytes, creating or overwriting it. */
  'fs.write': { params: { pid: string; path: string; bytes: Uint8Array }; result: Ok }
  /** List file paths, optionally restricted to those under `prefix`. */
  'fs.list': { params: { pid: string; prefix?: string }; result: string[] }
  /** Report whether a file exists. */
  'fs.exists': { params: { pid: string; path: string }; result: { exists: boolean } }
  /** Rename/move a file. */
  'fs.rename': { params: { pid: string; from: string; to: string }; result: Ok }
  /** Delete a file. */
  'fs.delete': { params: { pid: string; path: string }; result: Ok }

  // ── fs.* git ops — share the fs.* prefix but route to the git bridge.
  //    Signed-in server ops (commit, commitTree, deleteCommit,
  //    editCommitMessage) associate a canonical projectId first.

  /**
   * Commit the working tree. `author` overrides the default commit author.
   * Associates the project canonically (signed-in) before committing.
   */
  'fs.commit': {
    params: { pid: string; message: string; author?: CommitAuthor }
    result: { sha: string }
  }
  /** Read commit history, newest first, optionally paginated by `depth`/`skip`. */
  'fs.log': { params: { pid: string; depth?: number; skip?: number }; result: CommitInfo[] }
  /**
   * Read a file's bytes at a given revision. `shaLike` accepts anything iso-git
   * resolves (HEAD, HEAD~N, full/short sha, branch/tag refs).
   */
  'fs.showVersion': {
    params: { pid: string; shaLike: string; path: string }
    result: Uint8Array
  }
  /** Structured diff of the working tree, or against `sha` when given. */
  'fs.diff': { params: { pid: string; sha?: string }; result: DiffEntry[] }
  /** Check out a revision into the working tree. */
  'fs.checkout': { params: { pid: string; shaLike: string }; result: Ok }
  /** Current HEAD sha, or `null` on an unborn HEAD. */
  'fs.head': { params: { pid: string }; result: string | null }
  /** Whether the working tree has uncommitted changes. */
  'fs.hasUncommittedChanges': { params: { pid: string }; result: { dirty: boolean } }
  /**
   * "Copy forward" a source commit's tree as a new commit on HEAD (history is
   * preserved, not rewritten). Associates canonically first.
   */
  'fs.commitTree': {
    params: { pid: string; sourceSha: string; message: string; author?: CommitAuthor }
    result: { sha: string }
  }
  /**
   * Rewrite history to drop a commit, returning the new HEAD. Refuses the
   * initial commit. Associates canonically first.
   */
  'fs.deleteCommit': { params: { pid: string; sha: string }; result: { newHead: string } }
  /**
   * Rewrite a commit's message. Refuses the initial commit. Associates
   * canonically first. The host discards the rewritten head and acknowledges
   * with {@link Ok}.
   */
  'fs.editCommitMessage': {
    params: { pid: string; sha: string; newMessage: string }
    result: Ok
  }
  /** Flush any dirty in-memory docs to the filesystem. */
  'fs.flushDirty': { params: { pid: string }; result: Ok }

  // ── collab.* ────────────────────────────────────────────────────────────

  /**
   * Resolve a collaborative room for the project. `scope` defaults to
   * `'project'`; `'app'` is allowed and `'global'` is rejected. A local-only
   * project yields a `local:<scope>:<name>` descriptor with no server room.
   */
  'collab.openRoom': {
    params: { pid: string; name: string; scope?: 'project' | 'app'; projectName?: string }
    result: RoomDescriptor
  }

  // ── config.* ────────────────────────────────────────────────────────────

  /** Read the project's parsed config (always carries a `projectId`). Omit
   *  `pid` to get the running app's own identity, without display content. */
  'config.get': { params: { pid?: string }; result: ProjectConfig }

  // ── secrets.* ───────────────────────────────────────────────────────────

  /**
   * Report whether a named server-managed secret is set for the project. Never
   * reveals the value.
   */
  'secrets.check': { params: { pid: string; name: string }; result: { isSet: boolean } }
  /**
   * Proxy an outbound HTTPS request through the host, substituting `{{SECRET}}`
   * placeholders at the edge so the browser never sees the secret values.
   * Returns the response status, headers, and body.
   */
  'secrets.proxyFetch': {
    params: {
      pid: string
      url: string
      options?: { method?: string; headers?: Record<string, string>; body?: string }
    }
    result: { status: number; headers: Record<string, string>; body: string }
  }

  // ── ydocs.* ─────────────────────────────────────────────────────────────
  // @internal maturity: a complete spec, but apps normally reach these through
  // higher-level libraries (the y-indexeddb shim) rather than calling directly.

  /**
   * @internal Append a Yjs update to a doc's update log. Apps normally use the
   * y-indexeddb shim instead of calling this directly.
   */
  'ydocs.append': { params: { pid: string; docName: string; update: Uint8Array }; result: Ok }
  /**
   * @internal Read every stored update for a doc (the full log). Apps normally
   * use the y-indexeddb shim instead of calling this directly.
   */
  'ydocs.getAll': { params: { pid: string; docName: string }; result: Uint8Array[] }
  /**
   * @internal Atomically replace a doc's update log with a single compacted
   * snapshot. Apps normally use the y-indexeddb shim instead of calling this
   * directly.
   */
  'ydocs.snapshot': {
    params: { pid: string; docName: string; snapshotBytes: Uint8Array }
    result: Ok
  }
  /**
   * @internal Drop a doc's entire update store. Apps normally use the
   * y-indexeddb shim instead of calling this directly.
   */
  'ydocs.clear': { params: { pid: string; docName: string }; result: Ok }

  // ── profile.* ───────────────────────────────────────────────────────────
  // Reads flow straight through; mutations are gated by a host-rendered consent
  // dialog the app can't spoof. Mutation results use ProfileMutationResult so a
  // denied/conflicting call resolves to `{ ok: false, reason }` rather than
  // throwing.

  /**
   * Public read of a creator profile by handle. No consent (it's a read). A 404
   * (unclaimed handle) resolves to `{ exists: false }`. With a session the
   * server may set `isOwner`.
   */
  'profile.get': {
    params: { handle: string }
    result: { exists: false } | (Record<string, unknown> & { exists?: true })
  }
  /** Public read of the discovery landing: top creators + top apps by favorites. */
  'profile.discover': { params: Record<string, never>; result: Record<string, unknown> }
  /**
   * Consent-gated: claim a profile handle. Requires sign-in. Denied → `{ ok:
   * false, reason: 'denied' }`; a 409 conflict → `{ ok: false, reason:
   * 'handle_taken' }`.
   */
  'profile.claimHandle': { params: { handle: string }; result: ProfileMutationResult }
  /**
   * Consent-gated: link a content subproject as the source of profile content.
   * Requires sign-in. Denied → `{ ok: false, reason: 'denied' }`; a 403 → `{ ok:
   * false, reason: 'forbidden' }`.
   */
  'profile.setContentProject': {
    params: { projectId: string }
    result: ProfileMutationResult
  }
  /**
   * Consent-gated: publish the profile content publicly under `handle`.
   * Delegates to `publish.run` (with `shortName = handle`) on allow. Denied → `{
   * ok: false, reason: 'denied' }`. On allow resolves with the publish result
   * `{ canonical, alias }`.
   */
  'profile.publish': {
    params: { pid: string; handle: string }
    result: { ok: false; reason: string } | { canonical: string; alias: string | null }
  }
  /**
   * Toggle the viewer's favorite of a creator or app. NOT consent-gated
   * (reversible, self-scoped). Returns `{ ok, favorited, count }`; a 400 maps to
   * `{ ok: false, reason }`.
   */
  'profile.setFavorite': {
    params: { targetKind: 'creator' | 'app'; targetId: string }
    result: { ok: false; reason: string } | { ok: true; favorited: boolean; count: number }
  }

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * The signed-in viewer's OWN profile, resolved server-side from the session.
   * Same open shape as `profile.get` plus the editable fields `profile.update`
   * writes (`displayName`, `bio`, `location`, `link`), so a settings screen
   * reads exactly what it writes; `handle` and `isOwner: true` are the
   * guaranteed keys. Posture: gated-result — signed-out resolves
   * `{ ok: false, reason: 'sign_in_required' }` with ZERO network; a signed-in
   * viewer who never claimed a handle resolves
   * `{ ok: false, reason: 'no_profile' }` (render the claim-first affordance).
   * Discriminate on `'reason' in result`. Backing: profiles D1.
   */
  'profile.me': {
    params: Record<string, never>
    result:
      | { ok: false; reason: string }
      | (Record<string, unknown> & { handle: string; isOwner: true })
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * The viewer's favorites/follows, optionally filtered by `targetKind`. Reads
   * the same edge table `profile.setFavorite` writes (covers both favorites and
   * follows). Signed-in. Backing: favorites D1.
   */
  'profile.myFavorites': {
    params: { targetKind?: 'creator' | 'app' }
    result: { items: FavoriteEdge[] }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Followers of a creator by `handle` — the REVERSE of `profile.myFavorites`/
   * `profile.setFavorite`'s follow edge: not "who the viewer follows" but "who
   * follows this creator". Public read (no auth), keyset-paginated newest-first
   * via `{ cursor? }` → `{ items, nextCursor? }` (the same convention
   * `explore.listApps` uses). An unknown `handle` throws (the resource itself
   * is unresolved, unlike a filter param that legitimately degrades to an
   * empty page). Backing: favorites D1 (`idx_favorites_target`).
   */
  'profile.listFollowers': {
    params: { handle: string; cursor?: string }
    result: { items: MakerRef[]; nextCursor?: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Update the viewer's structured profile fields. Signed-in (signed-out
   * THROWS, consistent with the deployed `profile.*` mutations — unlike the
   * `explore.*` writes' result-value posture). The server owns `link`
   * normalization. Validation/permission failures arrive as
   * `{ ok: false, reason }` — including `'no_profile'` when the signed-in
   * viewer hasn't claimed a handle yet (render a claim-first affordance); the
   * success branch is intentionally open (the underlying server JSON is not
   * strongly typed at the wire boundary). Backing: profiles columns.
   */
  'profile.update': {
    params: {
      displayName?: string
      bio?: string
      location?: string
      link?: string
      /** Cross-app display theme (migration 0015). Persisted on the profile and
       *  surfaced via profile.me().theme so every platform app honors it. */
      theme?: 'system' | 'light' | 'dark'
    }
    result: ProfileMutationResult
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Read the viewer's notification preferences. Signed-in.
   * Backing: notification_prefs D1.
   */
  'profile.getNotificationPrefs': {
    params: Record<string, never>
    result: NotificationPrefs
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Update some notification preferences; returns the full updated prefs.
   * Signed-in. Backing: notification_prefs D1.
   */
  'profile.setNotificationPrefs': {
    params: Partial<NotificationPrefs>
    result: NotificationPrefs
  }

  // ── publish.* ───────────────────────────────────────────────────────────

  /**
   * Publish the project's HEAD under `shortName`. Requires sign-in (associates a
   * canonical projectId first). Emits coarse `publish.progress` pushes
   * throughout. `alias` is `null` when no alias was advanced.
   *
   * `possession.proven: false` means the publish itself succeeded but source
   * reads (pull / eject) stayed closed for this tree; republishing retries it.
   */
  'publish.run': {
    params: { pid: string; shortName: string }
    result: { canonical: string; alias: string | null; possession: PossessionOutcome }
  }

  // ── kernel.* ────────────────────────────────────────────────────────────

  /** Resolve the current user. Returns the anonymous sentinel when signed out. */
  'kernel.getUser': { params: Record<string, never>; result: User }
  /**
   * Sign in (opens the Google OAuth popup if needed). Resolves to the
   * authenticated user, or the current (anonymous) user if the popup is
   * dismissed. Also fires a `kernel.authChanged` push.
   */
  'kernel.signIn': { params: Record<string, never>; result: User }
  /**
   * Stop being identified to THIS app: the caller is recorded as anonymous for
   * this project. The user's myth.work and Google sessions are untouched — an
   * app cannot sign them out of the platform. Resolves with the anonymous
   * user; a `kernel.authChanged` push reconfirms.
   */
  'kernel.signOut': { params: Record<string, never>; result: User }

  // ── db.* ────────────────────────────────────────────────────────────────
  // @internal maturity: a complete spec, but apps normally reach these through
  // higher-level libraries (the key-value store helpers) rather than calling
  // directly. Note: db.* runs on the SAME port but is dispatched by the db
  // bridge, not the method router.

  /**
   * @internal Put a value under `(store, key)`. Resolves with `null`. Apps
   * normally use the higher-level store helpers instead.
   */
  'db.put': { params: { store: string; key: string; value: unknown }; result: null }
  /**
   * @internal Get the value at `(store, key)`, or read-through. Apps normally
   * use the higher-level store helpers instead.
   */
  'db.get': { params: { store: string; key: string }; result: unknown }
  /**
   * @internal Get every entry in a store. Apps normally use the higher-level
   * store helpers instead.
   */
  'db.getAll': {
    params: { store: string }
    result: { key: string; value: unknown }[]
  }
  /**
   * @internal Delete the value at `(store, key)`. Resolves with `null`. Apps
   * normally use the higher-level store helpers instead.
   */
  'db.delete': { params: { store: string; key: string }; result: null }
  /**
   * @internal Force a flush of the cloud sync queue. Resolves with `null`. Apps
   * normally use the higher-level store helpers instead.
   */
  'db.sync': { params: Record<string, never>; result: null }

  // ── explore.* ───────────────────────────────────────────────────────────
  // @experimental — API may still evolve before 1.0. These map to api-worker
  // discovery/engagement endpoints the host frame fulfills with a host-attached
  // Bearer. All reads are public/anonymous-OK; an attached session enriches
  // rows (`favoritedByViewer`, my rating). Engagement writes and `/me`-style
  // reads are sign-in gated host-side. Discovery operates on canonical project
  // ids: the param is `projectId`, never `pid`. Pagination uses
  // `{ cursor? }` → `{ items, nextCursor? }` (nextCursor absent on the last
  // page).
  //
  // Error posture: READS throw — a stale-token 401 propagates as an error
  // ('<method> failed: 401', no silent anonymous downgrade) and
  // existence-hiding 404s on getApp throw likewise. WRITES (rate, clearRating,
  // addComment) plus the one viewer read myRatings return `{ ok: false, reason
  // }` as a RESULT instead: 'sign_in_required' with zero network when signed
  // out, or the api's mapped 400/403/404 reason.

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * List published apps for discovery, filtered by `tags` (all-of), `maker`
   * (handle), and ordered by `sort` (default host-side `'popular'`). Public
   * read; an attached session enriches `favoritedByViewer`. Paginated.
   * Backing: projects + app_meta + app_tags + app_stats + profiles.
   */
  'explore.listApps': {
    params: { tags?: string[]; sort?: AppSort; maker?: string; cursor?: string }
    result: { items: AppSummary[]; nextCursor?: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Read one app's full detail by canonical `projectId`. Public read; an
   * attached session enriches `favoritedByViewer`. Backing: same tables as
   * `explore.listApps`; `remixCount`/`remixedFrom` via
   * `projects.forked_from_project_id`.
   */
  'explore.getApp': { params: { projectId: string }; result: AppDetail }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Apps related to the given `projectId` (shared tags). Public read.
   * Backing: app_tags.
   */
  'explore.relatedApps': {
    params: { projectId: string }
    result: { items: AppSummary[] }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Apps remixed FROM the given `projectId` — the reverse direction of
   * `explore.getApp`'s `remixedFrom`. Public read. Paginated.
   * Backing: `projects.forked_from_project_id` (migration 0012 reverse
   * index) joined to `apps`.
   */
  'explore.listRemixes': {
    params: { projectId: string; cursor?: string }
    result: { items: AppSummary[]; nextCursor?: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * The trending rail (7d vs prev-7d launches). Public read.
   * Backing: app_stats.
   */
  'explore.trendingApps': {
    params: Record<string, never>
    result: { items: AppSummary[] }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Today's App of the Day — launches_24h primary, gated by a minimum
   * bayesian rating (AGE-113). Public read. Backing: app_stats.
   */
  'explore.appOfDay': {
    params: Record<string, never>
    result: { items: AppSummary[] }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * This week's remix-weighted popularity (remix term pending Phase F,
   * currently 0) (AGE-113). Public read. Backing: app_stats.
   */
  'explore.popularWeek': {
    params: Record<string, never>
    result: { items: AppSummary[] }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Every tag with its app count. Public read. Backing: app_tags.
   */
  'explore.tags': { params: Record<string, never>; result: { items: TagCount[] } }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Search apps and makers by free text `q`. The `@handle` and `#tag` operators
   * are interpreted server-side. Public read. Backing: LIKE over
   * app_meta + profiles (D1 FTS5 at scale).
   */
  'explore.search': {
    params: { q: string }
    result: { apps: AppSummary[]; makers: MakerSummary[] }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * The seeded list of popular search terms. Public read.
   * Backing: editorial row / tiny table.
   */
  'explore.popularSearches': {
    params: Record<string, never>
    result: { items: string[] }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * The single editorial spotlight slot. Public read. An empty slot is an
   * expected state: `item` is `null` until the slot is seeded (the api 200s
   * with `{ item: null }`, never 404s). Backing: editorial_spotlight
   * (ops-seeded).
   */
  'explore.spotlight': {
    params: Record<string, never>
    result: { item: SpotlightItem | null }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * The editorial collections list. Public read.
   * Backing: editorial_collections (ops-seeded).
   */
  'explore.collections': {
    params: Record<string, never>
    result: { items: CollectionInfo[] }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Rate an app 1–5 stars. Signed-in: when no session exists the bridge
   * returns `{ ok: false, reason: 'sign_in_required' }` without touching the
   * network, and api-mapped failures (400/403/404-existence-hiding) arrive as
   * `{ ok: false, reason }`. Backing: ratings D1 (aggregated into app_stats).
   */
  'explore.rate': {
    params: { projectId: string; stars: 1 | 2 | 3 | 4 | 5 }
    result: Ok | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Clear the viewer's rating on an app (re-clicking the current star clears).
   * Signed-in; same `{ ok: false, reason }` result behavior as `explore.rate`.
   * Backing: ratings D1.
   */
  'explore.clearRating': {
    params: { projectId: string }
    result: Ok | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * The viewer's ratings, mapping canonical `projectId` → stars. Signed-in:
   * with no session the bridge returns `{ ok: false, reason:
   * 'sign_in_required' }` without a network call (the one read that uses the
   * write-style result instead of throwing). Backing: ratings D1.
   */
  'explore.myRatings': {
    params: Record<string, never>
    result: { ratings: Record<string, number> } | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * The signed-in viewer's own apps — published, unpublished, and
   * scan-gate-restricted, flagged rather than filtered. Unlike
   * `explore.listApps`, this NEVER excludes the viewer's own unpublished or
   * restricted apps; it surfaces their status instead so an owner can always
   * find something they unpublished. Signed-in: with no session the bridge
   * returns `{ ok: false, reason: 'sign_in_required' }` without a network
   * call, same as `explore.myRatings`. Backing: `apps` D1, scoped to the
   * authenticated viewer's own `publisher_user_id` only.
   *
   * `projectId` (optional): narrow to a single owned project — no cursor, no
   * `nextCursor`, at most one item. For a caller (e.g. an editor hydrating
   * its own open project's publish status) that needs one project's
   * status/alias without paging the whole list or using the existence-hiding
   * `explore.getApp` (wrong tool for "is *my* project published"). A
   * `projectId` the viewer doesn't own resolves to `items: []`, same as if
   * it were simply absent from the unfiltered list.
   */
  'explore.myApps': {
    params: { cursor?: string; projectId?: string }
    result: { items: MyAppSummary[]; nextCursor?: string } | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Apps where the signed-in viewer is an editor/viewer collaborator, NOT the
   * owner — owner-role apps live exclusively in `explore.myApps`, no overlap
   * between the two surfaces. Otherwise identical to `explore.myApps` (same
   * status derivation, same auth model, same pagination convention).
   * Signed-in: with no session the bridge returns
   * `{ ok: false, reason: 'sign_in_required' }` without a network call, same
   * as `explore.myApps`. Backing: `apps` D1 joined to `project_members`,
   * scoped to the authenticated viewer's editor/viewer role rows.
   */
  'explore.sharedWithMe': {
    params: { cursor?: string }
    result: { items: SharedAppSummary[]; nextCursor?: string } | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Mint a short-lived signed token proving the caller is the project's
   * owner/editor/viewer, so the serve worker can render the project's current
   * draft without a DB call. Member-gated (owner/editor/viewer): signed-out
   * resolves `{ ok: false, reason: 'sign_in_required' }` with ZERO network; a
   * non-member or unknown projectId → `{ ok: false, reason: 'forbidden' }`.
   * Backing: `project_members` role lookup + signed JWT (api worker).
   */
  'explore.mintPreviewToken': {
    params: { projectId: string }
    result: { ok: true; token: string; expiresAt: number } | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Owner-only toggle for durable, revocable "anyone with the link can view"
   * access to an unpublished app. `enabled: true` with no existing token
   * generates one; `regenerate: true` issues a new token, invalidating any
   * previously distributed link immediately; `enabled: false` alone is a full
   * revoke. Owner-gated EXACTLY (not editor/viewer): signed-out resolves
   * `{ ok: false, reason: 'sign_in_required' }` with ZERO network; a
   * non-owner or unknown projectId → `{ ok: false, reason: 'forbidden' }`.
   * Backing: `projects.link_sharing_enabled` / `projects.share_token`.
   */
  'explore.shareSettings': {
    params: { projectId: string; enabled: boolean; regenerate?: boolean }
    result:
      | { ok: true; enabled: boolean; shareToken: string | null }
      | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Read an app's comments, newest first, one level of nesting. Public read.
   * Paginated. Backing: comments D1.
   */
  'explore.comments': {
    params: { projectId: string; cursor?: string }
    result: { items: CommentNode[]; nextCursor?: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Add a comment, or a reply when `parentCommentId` is present. Replies cannot
   * be nested further (server-enforced one level). Signed-in; same
   * `{ ok: false, reason }` result behavior as `explore.rate`. On success
   * returns the new node (with empty `replies`). Backing: comments D1.
   */
  'explore.addComment': {
    params: { projectId: string; body: string; parentCommentId?: string }
    result: CommentNode | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Owner-update an app's editable metadata for canonical `projectId`. The
   * fields are stored as an owner OVERRIDE that the read path layers OVER the
   * publish-derived `name`/`tagline` (so an edit survives the owner's next
   * republish, rather than being clobbered by the index pipeline); `note` is
   * the maker's note. Owner-gated, posture gated-result: signed-out resolves
   * `{ ok: false, reason: 'sign_in_required' }` with ZERO network; a non-owner
   * → `{ ok: false, reason: 'forbidden' }`; an unknown app → `{ ok: false,
   * reason: 'not_found' }`. On success resolves the updated {@link AppDetail}.
   * Backing: app_meta D1 (owner-override), layered by get-app/summary.
   */
  'explore.updateAppMeta': {
    params: { projectId: string; name?: string; tagline?: string; note?: string }
    result: AppDetail | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Owner-unpublish the app at the canonical `projectId`. Reversible: removes
   * the site from the publish worker without deleting the project. Owner-gated;
   * posture gated-result — signed-out resolves `{ ok: false, reason:
   * 'sign_in_required' }` with ZERO network; a non-owner or unknown projectId →
   * `{ ok: false, reason: 'forbidden' }`. Backing: publish worker DELETE proxy.
   */
  'explore.unpublish': {
    params: { projectId: string }
    result: Ok | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Owner-delete the app at the canonical `projectId`: unpublishes (as above)
   * then soft-deletes the project row. Owner-gated; posture gated-result — same
   * as `explore.unpublish`. If the unpublish step hard-fails, the project row is
   * NOT deleted (no half-delete). Backing: publish worker DELETE proxy +
   * projects D1 softDelete.
   */
  'explore.deleteApp': {
    params: { projectId: string }
    result: Ok | { ok: false; reason: string }
  }

  // ── stacks.* ─────────────────────────────────────────────────────────────
  // Signed-in-scoped app collections (myth-fff PR #38 handoff item 3),
  // replacing the frontend's localStorage-only stacksStore.ts. Managing a
  // stack (listing, creating, renaming, adding apps, etc.) requires a
  // session — the exceptions are `resolveShare` and `discover`. A stack's own
  // `stackId` IS its share link — there is no separate token/`stacks.share`
  // method. Reads (`list`) throw on both axes (no token / any non-2xx) —
  // mirrors `profile.myFavorites`, private data with no anonymous-downgrade
  // posture. Writes are gated-result on both axes — mirrors
  // `explore.rate`/`addComment`: no token → `{ ok:false,
  // reason:'sign_in_required' }` with zero network; a 4xx → `{ ok:false,
  // reason }`.
  //
  // Membership (`stack_items`) is many-to-many: an app can belong to more
  // than one stack for the same owner. `foldedCategoryIds`/`categoryId` are
  // opaque, frontend-owned routing hints — the 24-item category taxonomy
  // itself isn't a backend concept (see the handoff doc's item 2, still an
  // open product question).
  //
  // `visibility` (defaults `'public'`) gates both `stacks.discover` and
  // `stacks.resolveShare`: `'private'` excludes a stack from discovery AND
  // makes resolveShare refuse anyone but the owner — checked live against
  // current state, so flipping a stack private instantly revokes every
  // previously-shared link (matches how Spotify/YouTube/Notion/Figma gate
  // link-sharing on a live flag rather than a rotatable secret).

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * The caller's own stacks, each with its current member project ids.
   * Signed-in; throws with no token or on any non-2xx. Unpaged — a bounded
   * personal set. Backing: stacks + stack_items (migration 0025).
   */
  'stacks.list': { params: Record<string, never>; result: { items: StackSummary[] } }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Create a stack. `kind` defaults `'custom'`; `foldedCategoryIds` defaults
   * `[]`; `visibility` defaults `'public'`. Gated-result on both axes. The
   * returned `stackId` doubles as the stack's share link (no separate
   * token).
   */
  'stacks.create': {
    params: {
      name: string
      kind?: StackKind
      foldedCategoryIds?: string[]
      visibility?: StackVisibility
    }
    result: StackSummary | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Rename a stack. Owner-gated: `stackId` not the caller's → `{ ok:false,
   * reason:'not_found' }` (no existence leak — a stack has no public
   * visibility to begin with).
   */
  'stacks.rename': {
    params: { stackId: string; name: string }
    result: Ok | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Delete a stack and its membership rows. Owner-gated, same posture as
   * `stacks.rename`.
   */
  'stacks.delete': { params: { stackId: string }; result: Ok | { ok: false; reason: string } }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Add an app to a stack (upserts the membership edge — an app can be in
   * more than one stack). `categoryId` tags which category this was routed
   * through, for `stacks.splitOutCategory`'s count; omit for a manual add
   * with no routing category. Owner-gated, same posture as `stacks.rename`.
   */
  'stacks.addApp': {
    params: { stackId: string; projectId: string; categoryId?: string }
    result: Ok | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Remove an app from a stack. Idempotent: a no-op success if the app isn't
   * currently in this stack. Owner-gated, same posture as `stacks.rename`.
   */
  'stacks.removeApp': {
    params: { stackId: string; projectId: string }
    result: Ok | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Atomically split a folded category out of `hostStackId` into its own
   * stack once it holds `threshold` or more items under `categoryId`:
   * creates a new stack scoped to just that category, moves the matching
   * items onto it, and strips `categoryId` out of the host's
   * `foldedCategoryIds`. Below `threshold`, OR `hostStackId` not the
   * caller's, both → `{ graduated: false }` (a stack has no public existence
   * to leak, so there's nothing gained by distinguishing the two here). The
   * category taxonomy/threshold is frontend-supplied, not backend policy —
   * see this section's header.
   *
   * The split-out stack is born `visibility: 'public'`; its `stackId` (on
   * `stack.stackId`) doubles as its share link, same as `stacks.create`.
   */
  'stacks.splitOutCategory': {
    params: { hostStackId: string; categoryId: string; newStackName: string; threshold: number }
    result:
      | { graduated: false }
      | { graduated: true; stack: StackSummary }
      | { ok: false; reason: string }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Resolve a stack by its own `stackId` — the id IS the share link — to its
   * current, visibility-gated contents. Anonymous-OK, along with
   * `stacks.discover` — every other method here requires a session.
   * `visibility: 'public'` resolves for anyone; `'private'` resolves only
   * for the owner (checked against an attached Bearer, if any). Unknown
   * stackId and private-not-owner both collapse to a uniform 404 that the
   * bridge THROWS (existence-hiding, same posture as `explore.getApp`'s 404 —
   * non-nullable result, no `null` branch to discriminate on).
   */
  'stacks.resolveShare': { params: { stackId: string }; result: SharedStack }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Paginated listing of `visibility: 'public'` stacks across all owners,
   * newest first. Anonymous-OK, same posture as `explore.listApps`/
   * `stacks.resolveShare`. Cursor-paginated (see `explore.listApps` for the
   * shared keyset-cursor convention).
   */
  'stacks.discover': {
    params: { cursor?: string; limit?: number }
    result: { items: StackSummary[]; nextCursor?: string }
  }

  // ── notifications.* ──────────────────────────────────────────────────────
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Page the viewer's full notification inbox, newest first. Signed-in.
   * Backing: notification_inbox D1.
   */
  'notifications.list': {
    params: { cursor?: string; limit?: number }
    result: { items: NotificationInboxItem[]; nextCursor: string | null }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Same as `notifications.list`, filtered to unread rows. Signed-in.
   * Backing: notification_inbox D1.
   */
  'notifications.listUnread': {
    params: { cursor?: string; limit?: number }
    result: { items: NotificationInboxItem[]; nextCursor: string | null }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Cheap unread badge count (no pagination). Signed-in.
   * Backing: notification_inbox D1.
   */
  'notifications.getUnreadCount': {
    params: Record<string, never>
    result: { count: number }
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Mark one inbox row read. Signed-in. Backing: notification_inbox D1.
   */
  'notifications.markRead': {
    params: { id: string }
    result: Ok
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Mark one inbox row unread. Signed-in. Backing: notification_inbox D1.
   */
  'notifications.markUnread': {
    params: { id: string }
    result: Ok
  }

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Submit the full claim in one authed call: lead fields (`name`, `email` —
   * contact preference, not identity) plus the REAL platform handle (claimed
   * through the same path as `PUT /handle`; there is no parallel reservation
   * namespace). `survey` is an opaque app-defined blob (≤4KB server-side) so
   * the platform doesn't ossify any one form's schema. Posture: gated-result —
   * signed-out returns `{ ok: false, reason: 'sign_in_required' }` with ZERO
   * network, which is the app's render-it-obvious "nothing was saved" signal
   * per the claims UX ruling. Other reasons include `handle_taken`,
   * `invalid_email`, `invalid_handle`, `invalid_name`, `terms_required`,
   * `rate_limited`. Semantics: re-claiming your current handle is an
   * idempotent ok; claiming a DIFFERENT handle is an atomic rename (old handle
   * freed + new one claimed in one write); the handle claim runs BEFORE the
   * lead upsert, so `handle_taken` fails the call without writing an orphan
   * lead row (retry-safe). Backing: claims D1 (lead) + profiles D1 (handle).
   */
  'profile.submitClaim': {
    params: {
      name: string
      email: string
      handle: string
      acceptedTerms: true
      survey?: Record<string, unknown>
    }
    result: Ok | { ok: false; reason: string }
  }
  /** Record that an approved user accepted their invite. Best-effort + idempotent;
   *  identity comes from the session. Returns the updated access block. */
  'profile.acceptInvite': { params: Record<string, never>; result: UserAccess }

  // ── prompts.* ─────────────────────────────────────────────────────────────
  // Server-stored system-prompt presets (AI-SDK Layer 1). Authoring is
  // HTTP-only (PUT /prompts/{projectId}); the client surface is names-only.

  /**
   * @experimental List prompt-preset NAMES for the current project (never
   * text). The projectId is derived host-side from the trusted current-project
   * context — there are NO client params (Correction A / security). Gated-result
   * posture: signed-out resolves `{ ok: false, reason: 'sign_in_required' }`
   * with ZERO network. Backing: project_prompts D1 (GET /prompts/:projectId).
   */
  'prompts.list': {
    params: Record<string, never>
    result: { names: string[] } | { ok: false; reason: string }
  }

  // ── env.* ─────────────────────────────────────────────────────────────────
  // Per-project encrypted env store. Values are stored in a `/.env` file in
  // the project tree, AES-256-GCM encrypted with a per-project KEK derived by
  // the platform. The KEK is never exposed to app code; only the host frame
  // can decrypt. Entries named `PROMPT_<NAME>` back agent persona presets.
  // No env.get in v1 — app-readable secret values need their own threat
  // modeling (see design doc: docs/superpowers/specs/2026-07-03-project-env-store-design.md).

  /**
   * @experimental List env-entry NAMES for the current project. Returns names
   * only — values are NEVER returned to app code (the host stores them
   * AES-256-GCM encrypted in `/.env`; only the host frame can decrypt them).
   * The projectId is derived host-side from the trusted current-project
   * context. Pass `pid` to target an open project the IDE has opened (e.g.
   * an IDE app editing a project that is not its own ctx). A local-only or
   * unauthenticated project resolves `{ names: [] }`. Entries named
   * `PROMPT_<NAME>` back agent persona presets (e.g. `PROMPT_GAIAD_VOICE` ↔
   * persona `gaiad_voice`). Wire: `env.list`.
   */
  'env.list': {
    params: { pid?: string }
    result: { names: string[] }
  }

  /**
   * @experimental Open the host-owned project-env editor popup. The host
   * renders the editor in its own DOM (app code cannot observe keystrokes or
   * plaintext values — same isolation boundary that protects the sign-in
   * surface). The editor shows entry names, masked values, and controls to
   * add, edit, and delete entries; Save encrypts all values and commits
   * `/.env`. Pass `pid` to target an open project the IDE has opened (e.g.
   * an IDE app editing a project that is not its own ctx). Resolves
   * `{ ok: true }` when the user saves, `{ ok: false }` when the popup is
   * cancelled or unavailable (signed-out, local-only project, or pid not
   * open). Wire: `env.open`.
   */
  'env.open': {
    params: { pid?: string }
    result: { ok: boolean }
  }

  // ── event.* ─────────────────────────────────────────────────────────────

  /**
   * Send a batch of events, captured by the calling app, to the platform —
   * generic ingest; error reports are the current use case, usage analytics
   * a planned one. Best-effort: the host forwards the batch server-side and
   * always resolves `Ok`, even if the forward itself fails. Caps (server-
   * enforced): `batch` ≤ 100 items; each item must be a JSON object whose
   * serialization is ≤ 8KB of UTF-8 bytes — a violating item is dropped and
   * counted server-side, never fatal to the rest of the batch.
   */
  'event.sendBatch': {
    params: { batch: Record<string, unknown>[] }
    result: Ok
  }

  // ── ai.* (mythwork-ai proxy) ────────────────────────────────────────────
  // @experimental — API may still evolve before 1.0. The app-facing surface of
  // the `mythwork-ai` proxy (PR #382): an OpenAI-compatible chat-completions
  // call the host frame fulfills with the host-held session Bearer (never
  // exposed to the app). The proxy returns ONE normalized
  // {@link ChatCompletion} for both providers. SIGN-IN REQUIRED: the worker
  // 401s without a session, so the bridge throws 'sign in required' with ZERO
  // network when signed out, and a non-2xx (incl. 402 out-of-credits / 429
  // rate-limited) throws — posture `signedOut: 'throw', onError: 'throw'`
  // (the hard-gated "do it" action, like `profile.myFavorites`).
  //
  // Streaming is opt-in via `stream: true` (the `@mythwork/sdk` `ai` namespace
  // sets it when the caller passes `onChunk`): the bridge relays text deltas as
  // correlated `ai.delta` pushes and still returns the full assembled
  // completion as the terminal reply. Without `stream`, the bridge delivers a
  // single buffered reply. Both resolve the full normalized completion; the
  // `ai` namespace adds the `ai.complete → string` / `ai.chat → message`
  // conveniences on top.

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Multi-turn chat completion. `messages` is the OpenAI-compatible turn list;
   * `opts` carries the OpenAI knobs ({@link import('./methods').AiOpts}, folded
   * into the request body by the client). Resolves the normalized
   * {@link ChatCompletion}. Sign-in required (the bridge throws when signed out
   * or on a non-2xx). Backing: mythwork-ai worker.
   */
  'ai.chat': {
    params: {
      messages: ChatMessage[]
      model?: string
      system?: string
      // Resolved to `system` bridge-side against the host's current project;
      // never reaches the mythwork-ai worker. Mutually exclusive with `system`.
      systemPreset?: string
      max_tokens?: number
      temperature?: number
      top_p?: number
      tools?: OpenAITool[]
      tool_choice?: unknown
      thinking?: boolean
      stream?: boolean
    }
    result: ChatCompletion
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Single-prompt completion convenience: `prompt` becomes one user turn; the
   * same OpenAI knobs apply. Resolves the normalized {@link ChatCompletion} (the
   * `@mythwork/sdk` `ai.complete` helper extracts the assistant text). Sign-in
   * required. Backing: mythwork-ai worker.
   */
  'ai.complete': {
    params: {
      prompt: string
      model?: string
      system?: string
      // Resolved to `system` bridge-side against the host's current project;
      // never reaches the mythwork-ai worker. Mutually exclusive with `system`.
      systemPreset?: string
      max_tokens?: number
      temperature?: number
      top_p?: number
      tools?: OpenAITool[]
      tool_choice?: unknown
      thinking?: boolean
      stream?: boolean
    }
    result: ChatCompletion
  }
  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Ask the platform to BUILD an app from a natural-language prompt and resolve
   * once its preview is live. Unlike `ai.chat`/`ai.complete` this does not talk
   * to the `mythwork-ai` proxy at all: the host frame submits a job to the
   * mythcode build server and streams its event feed.
   *
   * Resolves {@link BuildResult} at the FIRST preview — not at job completion.
   * The job keeps running behind the returned `previewUrl`, which mythcode
   * live-updates via its own HMR, so the page the caller opens keeps filling in
   * after this promise settles. `jobId` identifies the run for correlation.
   *
   * Progress: with `stream: true` (the `@mythwork/sdk` `ai.build` helper sets it
   * when the caller passes `onProgress`) each correlated `ai.delta` push carries
   * a JSON-encoded {@link BuildProgress} in its `delta` — NOT the free text the
   * `ai.chat`/`ai.complete` deltas carry. Without `stream` the call is silent
   * until it resolves.
   *
   * `projectId` is the project to build INTO, and unlike every other method here
   * it IS a caller argument. This is the one case where the host's own
   * `ctx.projectId` is the wrong id: the caller is a builder app (myth-fff),
   * so its current project is the BUILDER, while the app being generated lives
   * in a project the builder just created via `project.create`. The trust anchor
   * moves accordingly — the api worker authorizes the signed-in user against
   * this project (write role) before it will mint an assertion for it, so the
   * host frame never has to vouch for the id.
   *
   * FIRST-PARTY ONLY, for exactly that reason: a caller-named project plus a
   * signed-in user is enough to spend that user's credits building into any
   * project they own, so the host refuses the call outright from anything but a
   * platform app ('ai.build: not granted for this app'), the same gate
   * `nav.topLevel` uses.
   *
   * SIGN-IN REQUIRED, strictly, and separately from that gate — being a
   * first-party app says who is CALLING, the session says who the USER is, and
   * a build needs both. Only a real user session qualifies: the anonymous
   * first-party token that lets `ai.complete` work signed-out does NOT authorize
   * a build. Signed out → throws 'sign in required' with ZERO network.
   */
  'ai.build': {
    params: { prompt: string; projectId: string; stream?: boolean }
    result: BuildResult
  }

  // ── nav.* ───────────────────────────────────────────────────────────────

  /**
   * Host-mediated top-level browser navigation, first-party apps only (the
   * host throws for any other caller). Takes no app-supplied URL — only the
   * closed `target` enum — so the host alone resolves the actual destination
   * (via `mythworkZone()`), leaving no channel for a caller to smuggle data
   * into a redirect. Lets a first-party app (e.g. myth-ide) escape a
   * sandboxed iframe with no top-navigation grant to reach `explore.{zone}`.
   */
  'nav.topLevel': { params: { target: 'explore' }; result: Ok }

  /**
   * Host-mediated outbound link. The app frame carries no `allow-popups`, so
   * this is the ONLY way a hosted app can send a visitor off-site; the host
   * frame runs in the real top-level browsing context and opens the tab on
   * the app's behalf.
   *
   * The host classifies `url` against its own reviewed destination table and
   * either opens it, confirms it with the visitor, or refuses it — apps
   * granted `outbound_links = 'any'` skip straight to opening. Non-https URLs
   * are dropped.
   *
   * ALWAYS resolves `{ ok: true }`, whatever the host decided. A result that
   * distinguished opened from refused would let an app probe the destination
   * table and retarget its links at whatever slips through, so the outcome is
   * deliberately not observable.
   */
  'nav.openExternal': { params: { url: string }; result: Ok }

  /**
   * The in-app-routing <-> real-address-bar bridge. An app embedded in the
   * host frame's iframe owns its OWN session history — a router's
   * `history.pushState` only ever touches the iframe's window, which the
   * host's real, top-level address bar never learns about. `nav.reportLocation`
   * is how the app pushes its current path out to the host so the host can
   * mirror it with its OWN `history.pushState`/`replaceState` — never a real
   * navigation, so the iframe is never reloaded. The reverse direction (host
   * telling the app where to go, e.g. on a top-level back/forward) is the
   * `nav.navigate` push, not a method (see {@link EventMap}).
   *
   * Call on every route change, including the first one after mount.
   * `replace` mirrors the app's own history mode (a router `replace`
   * navigation should also `replace` at the top level, or the two history
   * stacks desync on back/forward). Available to any embedded app — unlike
   * `nav.topLevel`, this never leaves the app's own origin/iframe, so it
   * carries none of that method's escape-the-sandbox risk.
   */
  'nav.reportLocation': { params: { path: string; replace?: boolean }; result: Ok }

  // ── agent.* (hosted agent sessions — AI-SDK Layer 3) ────────────────────────
  // @experimental — bridge-local (no HTTP binding). Auth: gated-result posture
  // (signed-out → { ok:false, reason:'sign_in_required' } with ZERO network).
  // Sessions live in the host shell and survive app-iframe reloads. Content
  // arrives as `agent.event` pushes (per-session monotonic `seq`); the fast-ack
  // { turnId } from `agent.send` is a correlation handle only.

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Open a new agent session. All options are optional; omitted fields resolve
   * server-side defaults. v1 rejects `tools` declarations with
   * `{ ok:false, reason:'custom_tools_unsupported' }`. Gated-result: signed-out
   * resolves `{ ok:false, reason:'sign_in_required' }` with ZERO network.
   * Wire: `agent.create`.
   */
  'agent.create': {
    params: AgentSessionOptions
    result: { sessionId: string } | GatedResult
  }

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Start a turn by sending a user message. Resolves the fast-ack `{ turnId }`;
   * content arrives as `agent.event` pushes. Gated-result: signed-out →
   * `'sign_in_required'`; a turn already in progress → `'turn_in_progress'`.
   * Wire: `agent.send`.
   */
  'agent.send': {
    params: { sessionId: string; text: string; attachments?: unknown[] }
    result: { turnId: string } | GatedResult
  }

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Answer a pending `question` event; the turn resumes via events. Gated-result:
   * signed-out → `'sign_in_required'`. Wire: `agent.answer`.
   */
  'agent.answer': {
    params: { sessionId: string; questionId: string; answers: string[] }
    result: Ok | GatedResult
  }

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Abort the current turn; the session survives and emits `turn-done(stopped)`.
   * Gated-result: signed-out → `'sign_in_required'`. Wire: `agent.stop`.
   */
  'agent.stop': {
    params: { sessionId: string }
    result: Ok | GatedResult
  }

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Read session state for re-attach/replay. The `transcript` is bounded (oldest
   * turns dropped beyond cap). Gated-result: signed-out → `'sign_in_required'`.
   * Wire: `agent.state`.
   */
  'agent.state': {
    params: { sessionId: string }
    result: { status: AgentSessionStatus; transcript: unknown[] } | GatedResult
  }

  /**
   * @experimental — API may still evolve before 1.0.
   *
   * Tear down a session, aborting any in-progress turn. Gated-result: signed-out
   * → `'sign_in_required'`. Wire: `agent.dispose`.
   */
  'agent.dispose': {
    params: { sessionId: string }
    result: Ok | GatedResult
  }
}

/** Every valid wire method string. */
export type Method = keyof MethodMap

/** The `args` type for a given method. */
export type MethodParams<M extends Method> = MethodMap[M]['params']

/** The `result` type for a given method. */
export type MethodResult<M extends Method> = MethodMap[M]['result']
