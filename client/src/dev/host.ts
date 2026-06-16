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
//   - profile.* mutations (setFavorite, myFavorites, update): signed-out THROWS
//     (the promise rejects), consistent with the deployed host bridge.
//   - profile.me: gated-RESULT — signed-out → { ok:false, reason:'sign_in_required' };
//     signed-in with no handle → { ok:false, reason:'no_profile' };
//     signed-in with handle (the seeded dev user) → full profile shape.
//   - kernel.signIn/signOut: respond then emit kernel.authChanged push.
//   - Unknown method: { id, error: 'Unknown method: <m>' } (never hangs).

import type { PushMessage, RpcRequest, RpcResponse, User } from '@mythwork/protocol'
import type {
  AppSummary,
  CommentNode,
  CommentReply,
  CommitAuthor,
  CommitInfo,
  FavoriteEdge,
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
  commentSeq: number
  /**
   * The signed-in viewer's editable profile fields. Seeded from the maker on
   * sign-in, written by profile.update, read by profile.me — so a settings
   * screen reads exactly what it writes (the profile.me contract in methods.ts).
   */
  profileFields: { bio: string; location: string; link: string }
}

function freshState(): DevState {
  return {
    user: { kind: 'anonymous', userId: 'anonymous' },
    ratings: new Map(),
    favoriteApps: new Set(),
    favoriteCreators: new Set(),
    comments: new Map(),
    notifPrefs: { ...DEFAULT_NOTIF_PREFS },
    commentSeq: 1,
    profileFields: { bio: '', location: '', link: '' },
  }
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

function devSha(project: DevProject): string {
  return `dev${(project.commits.length + 1).toString().padStart(7, '0')}`
}

// ── handler table ─────────────────────────────────────────────────────────────

/** Per-request context: the calling client's host-side port, used to register
 * project subscribers and to exclude a writer from its own fs.changed pushes. */
interface HandlerCtx {
  hostPort: MessagePort
}

type Handler = (args: Record<string, unknown>, state: DevState, ctx: HandlerCtx) => unknown

const handlers: Record<string, Handler> = {
  // ── explore reads ──────────────────────────────────────────────────────────

  'explore.listApps'(args) {
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
    return { items }
  },

  'explore.getApp'(args) {
    const projectId = args['projectId'] as string
    const app = SEED_APPS.find(a => a.projectId === projectId)
    if (!app) throw new Error(`explore.getApp: app ${projectId} not found`)
    return appSummaryToDetail(app)
  },

  'explore.relatedApps'(args) {
    const projectId = args['projectId'] as string
    const items = relatedApps(projectId)
    return { items }
  },

  'explore.trendingApps'() {
    return { items: SEED_TRENDING }
  },

  'explore.tags'() {
    // Recompute live to pick up any future dynamic changes (kept cheap by
    // returning the pre-computed SEED_TAG_COUNTS for now).
    const items: TagCount[] = SEED_TAG_COUNTS
    return { items }
  },

  'explore.search'(args) {
    const q = (args['q'] as string) ?? ''
    const apps: AppSummary[] = SEED_APPS.flatMap(a => {
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
      // Return a CommentNode shape (with empty replies) as the new node.
      return { id, author, body, createdAt, replies: [] } satisfies CommentNode
    }

    const node: CommentNode = { id, author, body, createdAt, replies: [] }
    list.unshift(node)
    return node
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

  // profile.me: gated-RESULT with three states.
  // Signed-out → { ok:false, reason:'sign_in_required' }
  // Signed-in but no handle → { ok:false, reason:'no_profile' }
  // Signed-in with handle → full profile shape + isOwner:true
  // The dev signed-in user (kernel.signIn) adopts the first SEED_MAKER's
  // handle ('devuser'), so the happy path is immediately reachable; the
  // no_profile branch is defensive — it documents the host contract but isn't
  // reachable in dev, since the dev signIn always adopts a seeded maker.
  'profile.me'(_args, state) {
    if (state.user.kind === 'anonymous') return { ok: false, reason: 'sign_in_required' }
    const user = state.user as { kind: string; userId: string; displayName?: string }
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

  // ── kernel ─────────────────────────────────────────────────────────────────

  'kernel.getUser'(_args, state) {
    return state.user
  },

  'kernel.signIn'(_args, state) {
    // Sign in as the first seed maker ('devuser') so profile.me + profile.get
    // are immediately resolvable on the happy path.
    const maker = SEED_MAKERS[0]!
    state.user = {
      kind: 'public',
      userId: maker.handle,
      displayName: maker.displayName,
      picture: '',
      profileUrl: `https://myth.work/@${maker.handle}`,
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
    return state.user
  },

  // ── project (shared store) ───────────────────────────────────────────────────

  'project.create'(args, _state, ctx) {
    const pid = `dev-p${pidSeq++}`
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

  // ── collab ───────────────────────────────────────────────────────────────────

  'collab.openRoom'(args) {
    const pid = args['pid'] as string
    const name = args['name'] as string
    const scope = (args['scope'] as string | undefined) ?? 'project'
    // A dev room id is shared across clients opening the same (pid, name, scope);
    // the dev collab relay (@mythwork/sdk/react devCollabRelayFactory) keys its
    // in-memory Y bridge on this id so two connect({ dev: true }) peers converge.
    return {
      roomId: `dev:${pid}:${scope}:${name}`,
      serverUrl: 'dev:relay',
      joinToken: undefined,
    } satisfies RoomDescriptor
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
 * @example
 * ```ts
 * import { createDevHost } from '@mythwork/sdk/dev'
 * import { MythworkClient } from '@mythwork/sdk'
 *
 * const client = new MythworkClient(createDevHost())
 * const { items } = await client.explore.listApps()
 * ```
 */
export function createDevHost(): MessagePort {
  const chan = new MessageChannel()
  const hostPort = chan.port1 // host side — receives requests, sends replies
  const appPort = chan.port2 // given to MythworkClient

  const state = freshState()

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
        const result = handler(req.args ?? {}, state, { hostPort })
        response = { id: req.id, result }
      } catch (err) {
        response = { id: req.id, error: err instanceof Error ? err.message : String(err) }
      }
    }

    hostPort.postMessage(response)

    // Emit kernel.authChanged push after sign-in / sign-out (after the RPC
    // reply so subscribers receive the push after the promise resolves).
    if (req.method === 'kernel.signIn' || req.method === 'kernel.signOut') {
      const push: PushMessage = { type: 'kernel.authChanged', user: state.user }
      hostPort.postMessage(push)
    }
  })

  return appPort
}
