// In-SDK dev host for local development without an app-side mock server.
//
// Creates a MessageChannel, answers the wire protocol on one end, and returns
// the other port ready for `new MythworkClient(port)` or `connect({ dev: true })`.
//
// Wire protocol: { id, method, args } request → { id, result } | { id, error }
// response. Pushes are { type, ...payload } (no id field).
//
// Auth posture (matches methods.ts exactly):
//   - explore writes (rate, clearRating, addComment) AND explore.myRatings:
//     gated-RESULT — signed-out returns { ok: false, reason: 'sign_in_required' }
//     as the result value, never throws.
//   - explore.updateAppMeta: gated-RESULT + owner-gated — signed-out → result
//     'sign_in_required', non-owner → 'forbidden', unknown app → 'not_found';
//     on success the owner override is layered over the seed (so a later
//     explore.getApp reads it back) → updated AppDetail.
//   - profile.* mutations (setFavorite, myFavorites, update): signed-out THROWS
//     (the promise rejects), consistent with the deployed host bridge.
//   - profile.claimHandle: signed-out THROWS (mirrors the real bridge's no-token
//     throw); on success records the claimed handle so profile.me resolves to a
//     full profile. (No consent dialog exists in the dev host, so there's no
//     'denied' path.)
//   - profile.me: gated-RESULT — signed-out → { ok:false, reason:'sign_in_required' };
//     signed-in with no handle → { ok:false, reason:'no_profile' };
//     signed-in with handle (the seeded dev user, or a claimed handle) → full
//     profile shape.
//   - noProfile start mode (createDevHost({ noProfile }) / connect({ dev: { noProfile }})):
//     kernel.signIn adopts a NON-seed-maker identity so profile.me reports
//     no_profile until profile.claimHandle records a handle — exercises the
//     explore onboarding flow in dev.
//   - firstParty mode (createDevHost({ firstParty }) / connect({ dev: { firstParty }})):
//     simulates an allowlisted/first-party app — anonymous ai.chat/ai.complete
//     RESOLVE (to a devCompletion echo) instead of throwing 'sign in required',
//     mirroring the production first-party token. Symmetric opt-out to the
//     default non-allowlisted throw. Also gates nav.topLevel (first-party apps
//     only, mirroring isFirstPartyApp() in the real host-iframe bridge).
//     Scoped to ai.*/nav.* ONLY: profile writes still throw when signed out,
//     faithful to production (the token authorizes ai.*/nav.*, nothing else).
//   - kernel.signIn/signOut: respond then emit kernel.authChanged push.
//   - Unknown method: { id, error: 'Unknown method: <m>' } (never hangs).

import type { AgentEvent, PushMessage, RpcRequest, RpcResponse, User } from '@mythwork/protocol'
import type {
  AppDetail,
  AppSummary,
  ChatCompletion,
  CommentNode,
  CommentReply,
  CommitAuthor,
  CommitInfo,
  FavoriteEdge,
  NotificationInboxItem,
  NotificationPrefs,
  ProjectInfo,
  ProjectRole,
  RoomDescriptor,
  TagCount,
} from '@mythwork/protocol'
import {
  DEFAULT_NOTIF_PREFS,
  SEED_APPS,
  SEED_COLLECTIONS,
  SEED_COMMENTS,
  SEED_MAKERS,
  SEED_POPULAR_SEARCHES,
  SEED_SPOTLIGHT,
  SEED_TAG_COUNTS,
  SEED_TRENDING,
  appSearchScore,
  appSummaryToDetail,
  makerSearchScore,
  relatedApps,
} from './seed'

// ── mutable dev state ─────────────────────────────────────────────────────────

interface DevAgentSession {
  sessionId: string
  /** True while a turn is in progress; guards turn_in_progress gating. */
  turnActive: boolean
  /** Pending stop request — honoured when the event script runs. */
  pendingStop: boolean
  /** Per-session monotonic seq counter for push envelopes. */
  seq: number
  /** Counter for generating deterministic turnIds. */
  turnCounter: number
  /** Bounded transcript for agent.state replay. */
  transcript: Array<{ role: 'user' | 'assistant'; content: string }>
}

interface DevState {
  user: User
  /** projectId → user rating (1–5). */
  ratings: Map<string, number>
  /** set of projectIds the viewer has favorited. */
  favoriteApps: Set<string>
  /** set of creator handles the viewer follows. */
  favoriteCreators: Set<string>
  /** projectId → list of CommentNode (lazy-seeded on first read). */
  comments: Map<string, CommentNode[]>
  notifPrefs: NotificationPrefs
  /** The viewer's in-app notification inbox — mirrors the server's
   * notification_inbox table. Comment/favorite handlers push onto this,
   * mirroring the real backend's recordNotification behavior in dev. */
  notifications: NotificationInboxItem[]
  /** Monotonic counter for dev notification ids (mirrors commentSeq). */
  notificationSeq: number
  commentSeq: number
  /**
   * The signed-in viewer's editable profile fields. Seeded from the maker on
   * sign-in, written by profile.update, read by profile.me — so a settings
   * screen reads exactly what it writes (the profile.me contract in methods.ts).
   */
  profileFields: { bio: string; location: string; link: string }
  /**
   * projectId → owner-set app-meta override (name/tagline/note), layered over
   * the published seed on read — mirrors the server's app_meta override store,
   * which wins over the publish-derived fields.
   */
  appMetaOverrides: Map<string, { name?: string; tagline?: string; note?: string }>
  /**
   * Start in the fresh-newcomer onboarding mode: kernel.signIn adopts a
   * non-seed-maker identity so profile.me reports `no_profile` until a handle
   * is claimed — exercising the explore onboarding flow in dev.
   */
  noProfile: boolean
  /**
   * Simulate a first-party / allowlisted app: anonymous `ai.chat`/`ai.complete`
   * resolve instead of throwing `'sign in required'` — mirroring production,
   * where the serve worker mints a first-party token so an allowlisted app's
   * anonymous visitors reach `ai.*` (e.g. myth-landing's signed-out hero
   * planner). Default (false) keeps the non-allowlisted "sign in required"
   * throw. NOTE: first-party only authorizes `ai.*`; profile writes still
   * require a real user session, so those handlers are unaffected.
   */
  firstParty: boolean
  /** The handle recorded by profile.claimHandle (undefined until claimed). */
  claimedHandle: string | undefined
  /** Active agent sessions keyed by sessionId. */
  agentSessions: Map<string, DevAgentSession>
  /** Monotonic counter for generating deterministic session ids. */
  agentSessionCounter: number
}

function freshState(
  opts: { user?: User; noProfile?: boolean; firstParty?: boolean } = {},
): DevState {
  return {
    user: opts.user ?? { kind: 'anonymous', userId: 'anonymous' },
    ratings: new Map(),
    favoriteApps: new Set(),
    favoriteCreators: new Set(),
    comments: new Map(),
    notifPrefs: { ...DEFAULT_NOTIF_PREFS },
    notifications: [],
    notificationSeq: 1,
    commentSeq: 1,
    profileFields: { bio: '', location: '', link: '' },
    appMetaOverrides: new Map(),
    noProfile: opts.noProfile ?? false,
    firstParty: opts.firstParty ?? false,
    claimedHandle: undefined,
    agentSessions: new Map(),
    agentSessionCounter: 0,
  }
}

type AppMetaOverride = { name?: string; tagline?: string; note?: string }

// Layer an owner override's name/tagline over any app summary or detail —
// mirrors the server's COALESCE(override, published) applied on EVERY read
// (cards, lists, search, AND detail), so dev shows no card↔detail divergence.
function applyAppMeta<T extends AppSummary>(app: T, ov: AppMetaOverride | undefined): T {
  if (!ov) return app
  return {
    ...app,
    ...(ov.name !== undefined ? { name: ov.name } : {}),
    ...(ov.tagline !== undefined ? { tagline: ov.tagline } : {}),
  }
}

// The full AppDetail for an app with its owner override applied: name/tagline
// plus the maker's note (which only exists on the detail).
function overriddenDetail(app: AppSummary, ov: AppMetaOverride | undefined): AppDetail {
  const detail = applyAppMeta(appSummaryToDetail(app), ov)
  return ov?.note !== undefined ? { ...detail, makersNote: ov.note } : detail
}

// Lazy-seed from SEED_COMMENTS on first access for either read or write;
// after that the live in-memory list (with any addComment entries) is reused.
function ensureCommentList(state: DevState, projectId: string): CommentNode[] {
  let list = state.comments.get(projectId)
  if (!list) {
    const seeded = SEED_COMMENTS[projectId]
    list = seeded ? seeded.map(c => ({ ...c, replies: [...c.replies] })) : []
    state.comments.set(projectId, list)
  }
  return list
}

// ── shared project store (the dev "backend") ───────────────────────────────────
//
// Unlike the per-client explore/profile state above, project data is MODULE-LEVEL
// and keyed by pid, so two `connect({ dev: true })` clients that open the SAME
// project share one file tree + commit log and see each other's `fs.changed`
// pushes — the cross-client behavior an editor app's turn-based multiplayer (e.g.
// tennis) needs. Live Y.Doc convergence rides the collab relay (see the
// `devCollabRelayFactory` in @mythwork/sdk/react), keyed on `collab.openRoom`'s
// shared room id.

interface DevProject {
  pid: string
  name: string
  /** Top-level package.json `description`; `null` when unset. */
  description: string | null
  files: Map<string, Uint8Array>
  /** Newest-first commit log. */
  commits: CommitInfo[]
  /** sha → committed file tree, for `fs.showVersion`. */
  snapshots: Map<string, Map<string, Uint8Array>>
  /** First opener becomes leader; later openers are followers. */
  leader: MessagePort | null
  /** Host ports that have opened this project — fs.changed push targets. */
  subscribers: Set<MessagePort>
}

const projects = new Map<string, DevProject>()
let pidSeq = 1

/** Clear the shared project store. Tests call this in `beforeEach` for isolation. */
export function _resetDevHostForTests(): void {
  projects.clear()
  pidSeq = 1
}

function ensureProject(pid: string): DevProject {
  let p = projects.get(pid)
  if (!p) {
    p = {
      pid,
      name: pid,
      description: null,
      files: new Map(),
      commits: [],
      snapshots: new Map(),
      leader: null,
      subscribers: new Set(),
    }
    projects.set(pid, p)
  }
  return p
}

/** Push `fs.changed` to every subscriber of `project` except the originator. */
function pushFsChanged(
  project: DevProject,
  origin: MessagePort,
  path: string,
  kind: 'created' | 'updated' | 'deleted',
): void {
  const msg: PushMessage = { type: 'fs.changed', pid: project.pid, path, kind }
  for (const port of project.subscribers) {
    if (port !== origin) port.postMessage(msg)
  }
}

/**
 * Push `project.descriptionChanged` to every subscriber of `project`. Unlike
 * `pushFsChanged`, the origin is NOT excluded: a description edit is a metadata
 * change the editing client wants to observe too (so `onDescriptionChanged`
 * fires on the same client that called `setDescription`).
 */
function pushDescriptionChanged(project: DevProject): void {
  const msg: PushMessage = {
    type: 'project.descriptionChanged',
    pid: project.pid,
    description: project.description,
  }
  for (const port of project.subscribers) port.postMessage(msg)
}

function devSha(project: DevProject): string {
  return `dev${(project.commits.length + 1).toString().padStart(7, '0')}`
}

/** A deterministic normalized OpenAI chat-completion for the dev ai.* handlers. */
function devCompletion(text: string, model?: string): ChatCompletion {
  return {
    id: 'dev-cmpl',
    object: 'chat.completion',
    created: 0,
    model: model ?? 'dev-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  }
}

/**
 * Execute the scripted canned turn for the dev agent stub. Pushes a sequence of
 * `agent.event` messages over `port` for `session`, finishing with `turn-done`.
 * If a project exists in the shared store, also performs a file-edit so that
 * `fs.changed` pushes fire — verifying the file-edit tool path end-to-end.
 */
function runDevAgentTurn(port: MessagePort, session: DevAgentSession, turnId: string): void {
  function push(event: AgentEvent): void {
    const msg: PushMessage = {
      type: 'agent.event',
      sessionId: session.sessionId,
      seq: session.seq++,
      event,
    }
    port.postMessage(msg)
  }

  if (session.pendingStop) {
    session.pendingStop = false
    session.turnActive = false
    push({ kind: 'turn-done', turnId, status: 'stopped' })
    return
  }

  push({ kind: 'turn-start', turnId })
  push({ kind: 'cycle-start', cycle: 1 })

  // File-edit segment: pick the first available project from the shared store
  // so `fs.changed` pushes fire, allowing PR-4/PR-5 tests to observe edits.
  const changedFiles: string[] = []
  const firstEntry = projects.entries().next()
  if (!firstEntry.done) {
    const [, project] = firstEntry.value
    const editPath = 'agent-edit.txt'
    const alreadyExists = project.files.has(editPath)
    project.files.set(editPath, new TextEncoder().encode(`agent was here\n`))
    // Push fs.changed to ALL project subscribers — the agent is a separate peer.
    const fsMsg: PushMessage = {
      type: 'fs.changed',
      pid: project.pid,
      path: editPath,
      kind: alreadyExists ? 'updated' : 'created',
    }
    for (const sub of project.subscribers) sub.postMessage(fsMsg)
    changedFiles.push(editPath)

    push({
      kind: 'tool-start',
      toolCallId: 'dev-tc1',
      tool: 'file_edit',
      detail: { path: editPath },
    })
    push({
      kind: 'tool-result',
      toolCallId: 'dev-tc1',
      ok: true,
      summary: `wrote ${editPath}`,
      filesChanged: [editPath],
    })
    push({ kind: 'cycle-start', cycle: 2 })
  }

  push({ kind: 'text-delta', delta: 'Hello ' })
  push({ kind: 'text-delta', delta: 'from the agent stub!' })
  push({ kind: 'text-done', text: 'Hello from the agent stub!' })
  push({ kind: 'changes', files: changedFiles })
  push({ kind: 'turn-done', turnId, status: 'ok' })

  session.transcript.push({ role: 'assistant', content: 'Hello from the agent stub!' })
  session.turnActive = false
}

// ── handler table ─────────────────────────────────────────────────────────────

/** Per-request context: the calling client's host-side port, used to register
 * project subscribers and to exclude a writer from its own fs.changed pushes.
 * `signInAs` lets an editor-app test seed the identity that `kernel.signIn`
 * adopts (distinct per dev client), instead of the default seed maker. */
interface HandlerCtx {
  hostPort: MessagePort
  signInAs?: User
}

type Handler = (args: Record<string, unknown>, state: DevState, ctx: HandlerCtx) => unknown

const handlers: Record<string, Handler> = {
  // ── explore reads ──────────────────────────────────────────────────────────

  'explore.listApps'(args, state) {
    const tags = args['tags'] as string[] | undefined
    const sort = (args['sort'] as string | undefined) ?? 'popular'
    const maker = args['maker'] as string | undefined
    let items = [...SEED_APPS]
    if (tags && tags.length > 0) {
      items = items.filter(a => tags.every(t => a.tags.includes(t)))
    }
    if (maker) {
      items = items.filter(a => a.maker.handle === maker)
    }
    if (sort === 'new') {
      items.sort((a, b) => b.publishedAt - a.publishedAt)
    } else if (sort === 'trending') {
      items.sort((a, b) => (b.trendPct ?? 0) - (a.trendPct ?? 0))
    } else {
      // popular: by launches desc
      items.sort((a, b) => b.launches - a.launches)
    }
    return { items: items.map(a => applyAppMeta(a, state.appMetaOverrides.get(a.projectId))) }
  },

  'explore.getApp'(args, state) {
    const projectId = args['projectId'] as string
    const app = SEED_APPS.find(a => a.projectId === projectId)
    if (!app) throw new Error(`explore.getApp: app ${projectId} not found`)
    return overriddenDetail(app, state.appMetaOverrides.get(projectId))
  },

  'explore.relatedApps'(args, state) {
    const projectId = args['projectId'] as string
    const items = relatedApps(projectId).map(a =>
      applyAppMeta(a, state.appMetaOverrides.get(a.projectId)),
    )
    return { items }
  },

  'explore.trendingApps'(_args, state) {
    return {
      items: SEED_TRENDING.map(a => applyAppMeta(a, state.appMetaOverrides.get(a.projectId))),
    }
  },

  'explore.tags'() {
    // Recompute live to pick up any future dynamic changes (kept cheap by
    // returning the pre-computed SEED_TAG_COUNTS for now).
    const items: TagCount[] = SEED_TAG_COUNTS
    return { items }
  },

  'explore.search'(args, state) {
    const q = (args['q'] as string) ?? ''
    // Apply the owner override BEFORE scoring so search finds the EDITED name
    // (mirrors the server re-indexing apps_fts on the override).
    const apps: AppSummary[] = SEED_APPS.map(a =>
      applyAppMeta(a, state.appMetaOverrides.get(a.projectId)),
    )
      .flatMap(a => {
        const s = appSearchScore(a, q)
        return s !== null ? [{ score: s, app: a }] : []
      })
      .sort((a, b) => b.score - a.score)
      .map(({ app }) => app)

    const makers = SEED_MAKERS.flatMap(m => {
      const s = makerSearchScore(m, q)
      return s !== null ? [{ score: s, maker: m }] : []
    })
      .sort((a, b) => b.score - a.score)
      .map(({ maker }) => maker)

    return { apps, makers }
  },

  'explore.popularSearches'() {
    return { items: SEED_POPULAR_SEARCHES }
  },

  'explore.spotlight'() {
    return { item: SEED_SPOTLIGHT }
  },

  'explore.collections'() {
    return { items: SEED_COLLECTIONS }
  },

  'explore.comments'(args, state) {
    const projectId = args['projectId'] as string
    const items = ensureCommentList(state, projectId)
    return { items }
  },

  // ── explore writes (gated-RESULT posture) ──────────────────────────────────

  'explore.rate'(args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const projectId = args['projectId'] as string
    const stars = args['stars'] as number
    state.ratings.set(projectId, stars)
    return { ok: true }
  },

  'explore.clearRating'(args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const projectId = args['projectId'] as string
    state.ratings.delete(projectId)
    return { ok: true }
  },

  'explore.myRatings'(_args, state) {
    // gated-RESULT: the one read that uses write-style result instead of throwing.
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const ratings: Record<string, number> = {}
    for (const [k, v] of state.ratings) ratings[k] = v
    return { ratings }
  },

  'explore.addComment'(args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const projectId = args['projectId'] as string
    const body = args['body'] as string
    const parentCommentId = args['parentCommentId'] as string | undefined

    const user = state.user as { kind: string; userId: string; displayName?: string }
    const author = { handle: user.userId, displayName: user.displayName ?? user.userId }
    const id = `dev-c${state.commentSeq++}`
    const createdAt = Date.now()

    const list = ensureCommentList(state, projectId)

    if (parentCommentId) {
      const parent = list.find(c => c.id === parentCommentId)
      if (!parent) return { ok: false, reason: 'not_found' }
      const reply: CommentReply = { id, author, body, createdAt }
      parent.replies.push(reply)
      state.notifications.unshift({
        id: `dev-n${state.notificationSeq++}`,
        category: 'comments',
        subject: 'New comment on your app',
        body,
        context: { appKey: projectId, commentId: id },
        read: false,
        createdAt,
      })
      // Return a CommentNode shape (with empty replies) as the new node.
      return { id, author, body, createdAt, replies: [] } satisfies CommentNode
    }

    const node: CommentNode = { id, author, body, createdAt, replies: [] }
    list.unshift(node)
    state.notifications.unshift({
      id: `dev-n${state.notificationSeq++}`,
      category: 'comments',
      subject: 'New comment on your app',
      body,
      context: { appKey: projectId, commentId: id },
      read: false,
      createdAt,
    })
    return node
  },

  'explore.updateAppMeta'(args, state) {
    // gated-RESULT (it's a save button): signed-out resolves a result, no throw.
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const projectId = args['projectId'] as string
    const app = SEED_APPS.find(a => a.projectId === projectId)
    if (!app) return { ok: false, reason: 'not_found' }
    // Owner-gated: only the app's maker can edit (mirrors the server's 403).
    const user = state.user as { userId: string }
    if (app.maker.handle !== user.userId) return { ok: false, reason: 'forbidden' }
    // Merge the provided fields into the override (partial — preserves the
    // rest) so a later explore.getApp reads exactly what was written.
    const next = { ...(state.appMetaOverrides.get(projectId) ?? {}) }
    if (args['name'] !== undefined) next.name = args['name'] as string
    if (args['tagline'] !== undefined) next.tagline = args['tagline'] as string
    if (args['note'] !== undefined) next.note = args['note'] as string
    state.appMetaOverrides.set(projectId, next)
    return overriddenDetail(app, next)
  },

  // ── profile reads ──────────────────────────────────────────────────────────

  'profile.get'(args) {
    const handle = args['handle'] as string
    const maker = SEED_MAKERS.find(m => m.handle === handle)
    if (!maker) return { exists: false }
    return {
      exists: true,
      handle: maker.handle,
      displayName: maker.displayName,
      appCount: maker.appCount,
      totalLaunches: maker.totalLaunches,
      bio: maker.bio ?? '',
      location: maker.location ?? '',
      link: maker.link ?? '',
      isOwner: false,
    }
  },

  // Consent-gated in the real bridge; the dev host has NO consent dialog, so
  // there is no 'denied' path here. Signed-out THROWS (mirrors the real
  // bridge's no-token throw). On success, records the handle so profile.me
  // resolves to the full profile shape — driving the explore onboarding flow.
  'profile.claimHandle'(args, state) {
    if (state.user.kind === 'anonymous') throw new Error('sign in required')
    const handle = String(args['handle'] ?? '')
      .trim()
      .toLowerCase()
    if (!handle) throw new Error('handle required')
    const user = state.user as { userId: string }
    // handle_taken: a seed maker already owns this handle, unless it's the
    // current user's own id or already this session's claimed handle.
    const seedOwned = SEED_MAKERS.some(m => m.handle === handle)
    if (seedOwned && handle !== user.userId && handle !== state.claimedHandle) {
      return { ok: false, reason: 'handle_taken' }
    }
    state.claimedHandle = handle
    return { handle, ownerUserId: user.userId }
  },

  // profile.me: gated-RESULT with three states.
  // Signed-out → { ok:false, reason:'sign_in_required' }
  // Signed-in but no handle → { ok:false, reason:'no_profile' }
  // Signed-in with handle → full profile shape + isOwner:true
  // In the default mode the dev signed-in user (kernel.signIn) adopts the first
  // SEED_MAKER's handle ('devuser'), so the happy path is immediately reachable.
  // The no_profile branch IS reachable in dev via the `noProfile` start mode
  // (signIn adopts a non-seed-maker identity); profile.claimHandle then records
  // a handle, after which profile.me resolves to the full profile shape below.
  'profile.me'(_args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const user = state.user as { kind: string; userId: string; displayName?: string }
    if (state.claimedHandle) {
      return {
        handle: state.claimedHandle,
        displayName: user.displayName ?? state.claimedHandle,
        appCount: 0,
        totalLaunches: 0,
        bio: state.profileFields.bio,
        location: state.profileFields.location,
        link: state.profileFields.link,
        isOwner: true as const,
      }
    }
    const maker = SEED_MAKERS.find(m => m.handle === user.userId)
    if (!maker) return { ok: false, reason: 'no_profile' }
    return {
      handle: maker.handle,
      displayName: user.displayName ?? maker.displayName,
      appCount: maker.appCount,
      totalLaunches: maker.totalLaunches,
      bio: state.profileFields.bio,
      location: state.profileFields.location,
      link: state.profileFields.link,
      isOwner: true as const,
    }
  },

  // ── profile mutations (THROW posture when signed out) ──────────────────────

  'profile.setFavorite'(args, state) {
    // methods.ts: signed-out profile.* mutations THROW.
    if (state.user.kind === 'anonymous') throw new Error('sign_in_required')
    const targetKind = args['targetKind'] as 'creator' | 'app'
    const targetId = args['targetId'] as string
    if (targetKind === 'app') {
      const was = state.favoriteApps.has(targetId)
      if (was) state.favoriteApps.delete(targetId)
      else state.favoriteApps.add(targetId)
      return { ok: true, favorited: !was, count: state.favoriteApps.size }
    }
    const was = state.favoriteCreators.has(targetId)
    if (was) state.favoriteCreators.delete(targetId)
    else state.favoriteCreators.add(targetId)
    if (!was) {
      const follower = state.user as { userId: string; displayName?: string }
      state.notifications.unshift({
        id: `dev-n${state.notificationSeq++}`,
        category: 'followers',
        subject: 'You have a new follower',
        body: 'Someone started following you on myth.work.',
        context: {
          followerUserId: follower.userId,
          followerHandle: follower.userId,
          followerDisplayName: follower.displayName ?? follower.userId,
        },
        read: false,
        createdAt: Date.now(),
      })
    }
    return { ok: true, favorited: !was, count: state.favoriteCreators.size }
  },

  'profile.myFavorites'(args, state) {
    // methods.ts: signed-out profile.* mutations THROW.
    if (state.user.kind === 'anonymous') throw new Error('sign_in_required')
    const targetKind = args['targetKind'] as 'creator' | 'app' | undefined
    const items: FavoriteEdge[] = []
    if (!targetKind || targetKind === 'app') {
      for (const targetId of state.favoriteApps) {
        items.push({ targetKind: 'app', targetId, createdAt: Date.now() })
      }
    }
    if (!targetKind || targetKind === 'creator') {
      for (const targetId of state.favoriteCreators) {
        items.push({ targetKind: 'creator', targetId, createdAt: Date.now() })
      }
    }
    return { items }
  },

  'profile.update'(args, state) {
    // methods.ts: signed-out profile.* mutations THROW.
    if (state.user.kind === 'anonymous') throw new Error('sign_in_required')
    const user = state.user as { kind: string; userId: string; displayName?: string }
    if (args['displayName'] !== undefined) {
      user.displayName = args['displayName'] as string
    }
    // Persist the structured fields so profile.me reads exactly what was
    // written; only overwrite a field the caller actually provided so a
    // partial update leaves the others intact.
    if (args['bio'] !== undefined) state.profileFields.bio = args['bio'] as string
    if (args['location'] !== undefined) state.profileFields.location = args['location'] as string
    if (args['link'] !== undefined) state.profileFields.link = args['link'] as string
    return {
      ok: true,
      displayName: user.displayName,
      bio: state.profileFields.bio,
      location: state.profileFields.location,
      link: state.profileFields.link,
    }
  },

  'profile.getNotificationPrefs'(_args, state) {
    return { ...state.notifPrefs }
  },

  'profile.setNotificationPrefs'(args, state) {
    Object.assign(state.notifPrefs, args)
    return { ...state.notifPrefs }
  },

  // ── notifications.* ────────────────────────────────────────────────────────

  'notifications.list'(args, state) {
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 20
    return { items: state.notifications.slice(0, limit), nextCursor: null }
  },

  'notifications.listUnread'(args, state) {
    const limit = typeof args['limit'] === 'number' ? args['limit'] : 20
    return { items: state.notifications.filter(n => !n.read).slice(0, limit), nextCursor: null }
  },

  'notifications.getUnreadCount'(_args, state) {
    return { count: state.notifications.filter(n => !n.read).length }
  },

  'notifications.markRead'(args, state) {
    const id = String(args['id'] ?? '')
    const n = state.notifications.find(n => n.id === id)
    if (n) n.read = true
    return { ok: true }
  },

  'notifications.markUnread'(args, state) {
    const id = String(args['id'] ?? '')
    const n = state.notifications.find(n => n.id === id)
    if (n) n.read = false
    return { ok: true }
  },

  // ── kernel ─────────────────────────────────────────────────────────────────

  'kernel.getUser'(_args, state) {
    return state.user
  },

  'kernel.signIn'(_args, state, ctx) {
    // An editor-app test can pin the post-sign-in identity per dev client via
    // `createDevHost({ signInAs })` so two players get distinct identities.
    if (ctx.signInAs) {
      state.user = ctx.signInAs
      return state.user
    }
    // noProfile start mode: adopt a NON-seed-maker identity so profile.me
    // reports `no_profile` until profile.claimHandle records a handle — drives
    // the explore onboarding flow. ('newcomer' is intentionally not a seed
    // maker handle.)
    if (state.noProfile) {
      state.user = {
        kind: 'public',
        userId: 'newcomer',
        displayName: 'New Maker',
        picture: '',
        profileUrl: '',
        access: {
          approved: false,
          approvedAt: null,
          acceptedAt: null,
          inviteCodeHash: null,
        },
      }
      state.profileFields = { bio: '', location: '', link: '' }
      return state.user
    }
    // Default: sign in as the first seed maker ('devuser') so profile.me +
    // profile.get are immediately resolvable on the happy path.
    const maker = SEED_MAKERS[0]!
    state.user = {
      kind: 'public',
      userId: maker.handle,
      displayName: maker.displayName,
      picture: '',
      profileUrl: `https://myth.work/@${maker.handle}`,
      access: {
        approved: true,
        approvedAt: '2024-01-01T00:00:00.000Z',
        acceptedAt: '2024-01-01T00:00:00.000Z',
        inviteCodeHash: null,
      },
    }
    // Seed the editable fields from the maker so profile.me shows the seed
    // profile before any edit, and a later profile.update round-trips.
    state.profileFields = {
      bio: maker.bio ?? '',
      location: maker.location ?? '',
      link: maker.link ?? '',
    }
    return state.user
  },

  'kernel.signOut'(_args, state) {
    state.user = { kind: 'anonymous', userId: 'anonymous' }
    state.profileFields = { bio: '', location: '', link: '' }
    state.claimedHandle = undefined
    return state.user
  },

  // ── ai (mythwork-ai proxy) ───────────────────────────────────────────────────
  // Sign-in required (the worker 401s without a session) → anonymous THROWS, like
  // the real bridge for a NON-allowlisted app. The `firstParty` opt-out
  // (createDevHost({ firstParty }) / connect({ dev: { firstParty }})) simulates an
  // allowlisted app: the serve worker mints a first-party token so anonymous
  // callers reach ai.* — so in firstParty mode an anonymous caller proceeds to
  // devCompletion just like a signed-in one (e.g. myth-landing's signed-out hero
  // planner). Returns a deterministic normalized OpenAI completion that echoes the
  // last user turn so an app's happy path renders without a network.

  'ai.chat'(args, state) {
    if (!state.firstParty && state.user.kind === 'anonymous') throw new Error('sign in required')
    const messages = (args['messages'] as { role?: string; content?: unknown }[]) ?? []
    const lastUser = [...messages].reverse().find(m => m.role === 'user')
    const echo = typeof lastUser?.content === 'string' ? lastUser.content : ''
    const preset = typeof args.systemPreset === 'string' ? ` [preset:${args.systemPreset}]` : ''
    return devCompletion(`(dev)${preset} ${echo}`, args['model'] as string | undefined)
  },

  'ai.complete'(args, state) {
    if (!state.firstParty && state.user.kind === 'anonymous') throw new Error('sign in required')
    const prompt = typeof args['prompt'] === 'string' ? (args['prompt'] as string) : ''
    const preset = typeof args.systemPreset === 'string' ? ` [preset:${args.systemPreset}]` : ''
    return devCompletion(`(dev)${preset} ${prompt}`, args['model'] as string | undefined)
  },

  // ── prompts (server-stored presets; dev has no store) ────────────────────────
  'prompts.list'() {
    return { names: [] as string[] }
  },

  // ── env.* (host-owned project env store; dev stub — no encrypted backing) ────
  // In production the host reads/writes `/.env` in the project tree (AES-256-GCM,
  // per-project KEK). The dev stub keeps an in-memory empty name set and resolves
  // env.open immediately — the real editor popup is host-side UI not available in
  // the dev host.
  'env.list'() {
    return { names: [] as string[] }
  },

  'env.open'() {
    // The real host renders an editor popup in its own DOM; the app cannot observe
    // keystrokes or plaintext values. The dev stub resolves immediately with ok:true.
    // To exercise the real editor, run against a deployed host.
    console.log(
      '[dev host] env.open: the project-env editor is host-owned and not available in the dev stub. Resolving { ok: true }.',
    )
    return { ok: true }
  },

  // ── project (shared store) ───────────────────────────────────────────────────

  'project.create'(args, _state, ctx) {
    // Dev-mock pid: sequential prefix for stable test output. Production hosts
    // draw a canonical p-prefixed 33-char Crockford id from a server-side pool.
    const pid = `dev${String(pidSeq++).padStart(14, '0')}`
    const project = ensureProject(pid)
    project.name = (args['projectName'] as string | undefined) ?? pid
    project.leader = ctx.hostPort
    project.subscribers.add(ctx.hostPort)
    return { pid, role: 'leader' } satisfies ProjectInfo
  },

  'project.open'(args, _state, ctx) {
    const pid = args['pid'] as string
    const project = ensureProject(pid)
    project.subscribers.add(ctx.hostPort)
    const role: ProjectRole =
      project.leader === null || project.leader === ctx.hostPort ? 'leader' : 'follower'
    if (project.leader === null) project.leader = ctx.hostPort
    return { pid, role } satisfies ProjectInfo
  },

  'project.close'(args, _state, ctx) {
    projects.get(args['pid'] as string)?.subscribers.delete(ctx.hostPort)
    return { ok: true }
  },

  'project.list'() {
    return { pids: [...projects.keys()] }
  },

  'project.getNames'(args) {
    // Names are stored on create (project.name); return the cached name per
    // pid. null for an unknown pid, mirroring the real host's "config not on
    // disk yet" semantics — though in the in-memory dev host every known
    // project always has a name.
    const pids = args['pids'] as string[]
    const names: Record<string, string | null> = {}
    for (const pid of pids) names[pid] = projects.get(pid)?.name ?? null
    return { names }
  },

  'project.getDescription'(args) {
    // Description is stored on the project (project.setDescription); null for an
    // unknown pid or an unset description, mirroring the real host's "no
    // description on disk yet" semantics.
    return { description: projects.get(String(args['pid']))?.description ?? null }
  },

  'project.setDescription'(args, _state, ctx) {
    const project = ensureProject(String(args['pid']))
    project.subscribers.add(ctx.hostPort)
    // Empty string reads back as null, mirroring getDescription's unset path.
    project.description = (args['description'] as string) || null
    // Notify subscribers (incl. the editing client) so onDescriptionChanged fires.
    pushDescriptionChanged(project)
    return { ok: true }
  },

  // ── fs (shared store; writes push fs.changed to other clients) ───────────────

  'fs.read'(args) {
    const project = ensureProject(args['pid'] as string)
    const path = args['path'] as string
    const bytes = project.files.get(path)
    if (!bytes) throw new Error(`fs.read: ${path} not found`)
    return bytes
  },

  'fs.write'(args, _state, ctx) {
    const project = ensureProject(args['pid'] as string)
    const path = args['path'] as string
    const existed = project.files.has(path)
    project.files.set(path, args['bytes'] as Uint8Array)
    pushFsChanged(project, ctx.hostPort, path, existed ? 'updated' : 'created')
    return { ok: true }
  },

  'fs.list'(args) {
    const project = ensureProject(args['pid'] as string)
    const prefix = args['prefix'] as string | undefined
    const paths = [...project.files.keys()]
    return prefix ? paths.filter(p => p.startsWith(prefix)) : paths
  },

  'fs.exists'(args) {
    const project = ensureProject(args['pid'] as string)
    return { exists: project.files.has(args['path'] as string) }
  },

  'fs.rename'(args, _state, ctx) {
    const project = ensureProject(args['pid'] as string)
    const from = args['from'] as string
    const to = args['to'] as string
    const bytes = project.files.get(from)
    if (bytes) {
      project.files.delete(from)
      project.files.set(to, bytes)
      pushFsChanged(project, ctx.hostPort, from, 'deleted')
      pushFsChanged(project, ctx.hostPort, to, 'created')
    }
    return { ok: true }
  },

  'fs.delete'(args, _state, ctx) {
    const project = ensureProject(args['pid'] as string)
    const path = args['path'] as string
    if (project.files.delete(path)) pushFsChanged(project, ctx.hostPort, path, 'deleted')
    return { ok: true }
  },

  // ── git (wire fs.*; commit snapshots the tree for showVersion) ───────────────

  'fs.commit'(args, _state, ctx) {
    const project = ensureProject(args['pid'] as string)
    const author = args['author'] as CommitAuthor | undefined
    const sha = devSha(project)
    project.commits.unshift({
      sha,
      message: args['message'] as string,
      timestamp: new Date(0),
      author: author?.name ?? 'dev',
      authorEmail: author?.email ?? 'dev@mythwork.local',
    })
    project.snapshots.set(sha, new Map(project.files))
    // HEAD moved — nudge other clients so their git state refreshes (tennis wires
    // files.subscribe(() => git.refresh()), so fs.changed drives the re-fetch).
    pushFsChanged(project, ctx.hostPort, '/', 'updated')
    return { sha }
  },

  'fs.commitTree'(args, _state, ctx) {
    // "Copy forward" a source commit's tree as a NEW commit on HEAD: restore the
    // snapshot into the working tree, then commit it. History grows; HEAD never
    // moves backward — matches the protocol's commitTree contract and the real
    // host's restore semantics.
    const project = ensureProject(args['pid'] as string)
    const sourceSha = args['sourceSha'] as string
    const source = project.snapshots.get(sourceSha)
    if (!source) throw new Error(`fs.commitTree: ${sourceSha} not found`)
    const author = args['author'] as CommitAuthor | undefined
    project.files = new Map(source)
    const sha = devSha(project)
    project.commits.unshift({
      sha,
      message: args['message'] as string,
      timestamp: new Date(0),
      author: author?.name ?? 'dev',
      authorEmail: author?.email ?? 'dev@mythwork.local',
    })
    project.snapshots.set(sha, new Map(project.files))
    pushFsChanged(project, ctx.hostPort, '/', 'updated')
    return { sha }
  },

  'fs.log'(args) {
    const project = ensureProject(args['pid'] as string)
    const depth = args['depth'] as number | undefined
    return depth ? project.commits.slice(0, depth) : project.commits
  },

  'fs.head'(args) {
    const project = ensureProject(args['pid'] as string)
    return project.commits[0]?.sha ?? null
  },

  'fs.hasUncommittedChanges'() {
    return { dirty: false }
  },

  'fs.showVersion'(args) {
    const project = ensureProject(args['pid'] as string)
    const shaLike =
      (args['shaLike'] as string) === 'HEAD'
        ? (project.commits[0]?.sha ?? '')
        : (args['shaLike'] as string)
    const path = args['path'] as string
    const bytes = project.snapshots.get(shaLike)?.get(path)
    if (!bytes) throw new Error(`fs.showVersion: ${shaLike}:${path} not found`)
    return bytes
  },

  // ── nav ──────────────────────────────────────────────────────────────────────

  'nav.topLevel'(args, state) {
    // Mirrors packages/host-iframe/src/bridges/nav.ts: first-party apps only,
    // and only the closed `target` enum is accepted.
    if (!state.firstParty) throw new Error('nav.topLevel: first-party apps only')
    const target = String(args['target'] ?? 'explore')
    if (target !== 'explore') throw new Error(`nav.topLevel: unknown target '${target}'`)
    // Unlike production, do NOT assign window.location.href here: there's no
    // real explore.{zone} to navigate to during local dev (redirecting off
    // localhost would break the dev loop), and jsdom-based tests would throw
    // "Not implemented: navigation" if we tried. Just report success.
    return { ok: true }
  },

  // ── collab ───────────────────────────────────────────────────────────────────

  'collab.openRoom'(args) {
    const pid = args['pid'] as string
    const name = args['name'] as string
    const scope = (args['scope'] as string | undefined) ?? 'project'
    // A dev room id is shared across clients opening the same room; the dev
    // collab relay (@mythwork/sdk/react devCollabRelayFactory) keys its in-memory
    // Y bridge on this id so two connect({ dev: true }) peers converge. An
    // `app`-scoped room is app-wide and pid-INDEPENDENT (mirrors the real host):
    // clients reach the same app room from any project context (e.g. tennis's
    // lobby, opened both from the landing page and from inside a match).
    const roomId = scope === 'app' ? `dev:app:${name}` : `dev:${pid}:project:${name}`
    return { roomId, serverUrl: 'dev:relay', joinToken: undefined } satisfies RoomDescriptor
  },

  // ── agent.* (hosted agent sessions — AI-SDK Layer 3) ──────────────────────

  'agent.create'(args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    // v1 rejects custom tool declarations
    if (Array.isArray(args['tools']) && (args['tools'] as unknown[]).length > 0) {
      return { ok: false, reason: 'custom_tools_unsupported' }
    }
    const sessionId = `dev-session-${++state.agentSessionCounter}`
    const session: DevAgentSession = {
      sessionId,
      turnActive: false,
      pendingStop: false,
      seq: 0,
      turnCounter: 0,
      transcript: [],
    }
    state.agentSessions.set(sessionId, session)
    return { sessionId }
  },

  'agent.send'(args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const sessionId = args['sessionId'] as string
    const text = args['text'] as string
    const session = state.agentSessions.get(sessionId)
    if (!session) throw new Error(`agent.send: unknown session ${sessionId}`)
    if (session.turnActive) return { ok: false, reason: 'turn_in_progress' }
    session.turnActive = true
    session.pendingStop = false
    const turnId = `dev-turn-${++session.turnCounter}`
    session.transcript.push({ role: 'user', content: text })
    // Note: event script is scheduled asynchronously (via setTimeout in the
    // post-response hook below) so turnActive stays true until the next tick —
    // enabling turn_in_progress gating tests.
    return { turnId }
  },

  'agent.answer'(args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const sessionId = args['sessionId'] as string
    const session = state.agentSessions.get(sessionId)
    if (!session) throw new Error(`agent.answer: unknown session ${sessionId}`)
    // Intentionally a no-op in the dev stub; no scripted question turn in v1.
    return { ok: true }
  },

  'agent.stop'(args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const sessionId = args['sessionId'] as string
    const session = state.agentSessions.get(sessionId)
    if (!session) throw new Error(`agent.stop: unknown session ${sessionId}`)
    if (session.turnActive) session.pendingStop = true
    return { ok: true }
  },

  'agent.state'(args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const sessionId = args['sessionId'] as string
    const session = state.agentSessions.get(sessionId)
    if (!session) throw new Error(`agent.state: unknown session ${sessionId}`)
    return {
      status: session.turnActive ? 'active' : 'idle',
      transcript: [...session.transcript],
    }
  },

  'agent.dispose'(args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const sessionId = args['sessionId'] as string
    const session = state.agentSessions.get(sessionId)
    if (!session) throw new Error(`agent.dispose: unknown session ${sessionId}`)
    state.agentSessions.delete(sessionId)
    return { ok: true }
  },
}

// ── DevHost factory ───────────────────────────────────────────────────────────

/**
 * Create an in-SDK dev host backed by generic seed fixtures.
 *
 * Returns the `MessagePort` to pass to `new MythworkClient(port)`. The host
 * answers all explore/profile/kernel methods over the port and emits
 * `kernel.authChanged` pushes on sign-in/sign-out.
 *
 * Use directly for tests or advanced dev setups; prefer `connect({ dev: true })`
 * for the idiomatic API.
 *
 * Pass `opts.user` to seed the signed-in identity (editor apps simulating
 * distinct players give each dev client its own identity) and `opts.signInAs`
 * to pin what `kernel.signIn` adopts instead of the default seed maker. Pass
 * `opts.noProfile` to start in onboarding mode: `kernel.signIn` adopts a
 * non-seed-maker identity so `profile.me` reports `no_profile` until
 * `profile.claimHandle` records a handle — exercising the explore onboarding
 * flow in dev. Pass `opts.firstParty` to simulate an allowlisted/first-party
 * app so anonymous `ai.chat`/`ai.complete` resolve instead of throwing
 * `'sign in required'` — mirroring the production first-party token (e.g.
 * myth-landing's signed-out hero planner) — and so `nav.topLevel` resolves
 * instead of throwing `'first-party apps only'`.
 *
 * @example
 * ```ts
 * import { createDevHost } from '@mythwork/sdk/dev'
 * import { MythworkClient } from '@mythwork/sdk'
 *
 * const client = new MythworkClient(createDevHost())
 * const { items } = await client.explore.listApps()
 *
 * // Editor app: two players with distinct identities.
 * const a = new MythworkClient(createDevHost({ user: { kind: 'pseudonymous', userId: 'a', displayName: 'Ann' } }))
 * const b = new MythworkClient(createDevHost({ user: { kind: 'pseudonymous', userId: 'b', displayName: 'Bob' } }))
 * ```
 */
export function createDevHost(opts?: {
  user?: User
  signInAs?: User
  noProfile?: boolean
  firstParty?: boolean
}): MessagePort {
  const chan = new MessageChannel()
  const hostPort = chan.port1 // host side — receives requests, sends replies
  const appPort = chan.port2 // given to MythworkClient

  const state = freshState({
    user: opts?.user,
    noProfile: opts?.noProfile,
    firstParty: opts?.firstParty,
  })

  hostPort.start()
  appPort.start()

  hostPort.addEventListener('message', (e: MessageEvent) => {
    const req = e.data as RpcRequest | null
    if (!req || typeof req.id !== 'string' || typeof req.method !== 'string') return

    const handler = handlers[req.method]
    let response: RpcResponse

    if (!handler) {
      response = { id: req.id, error: `Unknown method: ${req.method}` }
    } else {
      try {
        const result = handler(req.args ?? {}, state, { hostPort, signInAs: opts?.signInAs })
        response = { id: req.id, result }
      } catch (err) {
        response = { id: req.id, error: err instanceof Error ? err.message : String(err) }
      }
    }

    // Streaming AI request: emit ai.delta pushes BEFORE the terminal reply so
    // streamOverPort's delta listener fires before its reply listener resolves.
    if (
      !response.error &&
      req.args.stream === true &&
      (req.method === 'ai.complete' || req.method === 'ai.chat')
    ) {
      const completion = response.result as ChatCompletion
      const content = completion.choices?.[0]?.message?.content
      const text = typeof content === 'string' ? content : ''
      // Guard: skip the chunk loop entirely when text is empty — never emit an
      // empty delta, never throw. For non-empty text split into ≤3 same-size
      // chunks so the streaming path exercises ≥1 delta.
      if (text) {
        const chunkSize = Math.ceil(text.length / 3)
        for (let i = 0; i < text.length; i += chunkSize) {
          hostPort.postMessage({
            type: 'ai.delta',
            requestId: req.id,
            delta: text.slice(i, i + chunkSize),
          })
        }
      }
    }

    hostPort.postMessage(response)

    // Async agent event script: schedule AFTER the fast-ack so turnActive
    // stays true until the next tick, enabling turn_in_progress gating.
    if (req.method === 'agent.send' && !response.error) {
      const sendResult = response.result as { turnId?: string } | undefined
      const turnId = sendResult?.turnId
      if (turnId) {
        const sessionId = req.args['sessionId'] as string
        const session = state.agentSessions?.get(sessionId)
        if (session) {
          setTimeout(() => {
            runDevAgentTurn(hostPort, session, turnId)
          }, 0)
        }
      }
    }

    // Emit kernel.authChanged push after sign-in / sign-out (after the RPC
    // reply so subscribers receive the push after the promise resolves).
    if (req.method === 'kernel.signIn' || req.method === 'kernel.signOut') {
      const push: PushMessage = { type: 'kernel.authChanged', user: state.user }
      hostPort.postMessage(push)
    }
  })

  return appPort
}
