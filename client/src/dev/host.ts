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
  FavoriteEdge,
  NotificationPrefs,
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

// ── handler table ─────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, state: DevState) => unknown

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
  // handle ('devuser'), so the happy path is immediately reachable.
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
      bio: maker.bio ?? '',
      location: maker.location ?? '',
      link: maker.link ?? '',
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
    return {
      ok: true,
      displayName: user.displayName,
      bio: args['bio'] ?? '',
      location: args['location'] ?? '',
      link: args['link'] ?? '',
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
    return state.user
  },

  'kernel.signOut'(_args, state) {
    state.user = { kind: 'anonymous', userId: 'anonymous' }
    return state.user
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
        const result = handler(req.args ?? {}, state)
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
