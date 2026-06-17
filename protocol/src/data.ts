// Pure data types referenced by the method and event maps. These are the
// canonical copies the protocol owns — the package defines its own copy so it
// stays self-contained. Each shape is verified against the live host behavior.

/**
 * The resolved platform identity of the current user. A discriminated union on
 * `kind`.
 *
 * - `anonymous`: no authenticated session (sentinel `userId: 'anonymous'`).
 * - `pseudonymous`: signed in under a project-scoped display name.
 * - `public`: signed in with the full public profile (avatar + profile URL).
 */
export type User =
  | { kind: 'anonymous'; userId: string }
  | { kind: 'pseudonymous'; userId: string; displayName: string }
  | {
      kind: 'public'
      userId: string
      displayName: string
      picture: string
      profileUrl: string
    }

/**
 * Commit author override accepted by the git write methods (`fs.commit`,
 * `fs.commitTree`). When omitted, the host applies the registry-configured
 * default author.
 */
export interface CommitAuthor {
  name: string
  email: string
}

/**
 * One commit as returned by `fs.log`. `timestamp` is a `Date` — it survives
 * structured clone, so it arrives as a real `Date` on the inner side, not a
 * string.
 */
export interface CommitInfo {
  sha: string
  message: string
  timestamp: Date
  /** Author display name. */
  author: string
  /** Author email — apps use this as the stable per-device identity. */
  authorEmail: string
}

/** A single line inside a {@link DiffHunk}. */
export interface DiffLine {
  type: 'add' | 'delete' | 'context'
  content: string
}

/** A contiguous run of changed lines within a {@link DiffEntry}. */
export interface DiffHunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: DiffLine[]
}

/**
 * One changed file as returned by `fs.diff`. The wire shape is
 * `{ filepath, status, hunks }` — the structured form with line-level hunks is
 * what actually crosses the port.
 */
export interface DiffEntry {
  filepath: string
  status: 'added' | 'modified' | 'deleted'
  hunks: DiffHunk[]
}

/**
 * The descriptor `collab.openRoom` returns for joining a collaborative room.
 * For an associated (canonical) project this names a server room with a signed
 * `joinToken`; for a local-only project the host returns a
 * `local:<scope>:<name>` descriptor with an empty `serverUrl` and no
 * `joinToken`.
 */
export interface RoomDescriptor {
  roomId: string
  serverUrl: string
  /**
   * Short-lived signed join token appended to the WebSocket URL (`?jt=<token>`)
   * so the collab server verifies the HMAC on connect. Absent for the
   * local-first branch (`local:<scope>:<name>`, no WebSocket).
   */
  joinToken?: string
}

/**
 * A project's role within the session. `leader` owns authoritative writes;
 * `follower` mirrors.
 */
export type ProjectRole = 'leader' | 'follower'

/**
 * The identity returned by project open/create: the local handle id (`pid`) and
 * the session {@link ProjectRole}.
 */
export interface ProjectInfo {
  pid: string
  role: ProjectRole
}

/**
 * The parsed `orbitcode.config.json` returned by `config.get`. Always carries a
 * `projectId` (the host backfills it to the `pid` when the file is missing or
 * lacks one) plus whatever else the project's config holds.
 */
export type ProjectConfig = { projectId: string } & Record<string, unknown>

/**
 * The trivial success acknowledgement returned by void-like methods (writes,
 * deletes, etc.).
 */
export type Ok = { ok: true }

// ── explore surface ─────────────────────────────────────────────────────────
// @experimental — API may still evolve before 1.0.
// The shapes below back the `explore.*` and `profile.*` methods.
// Timestamps are epoch milliseconds as `number` (field suffix `At`): the
// payloads originate as integers and cross JSON, so no `Date` is used here.

/**
 * @experimental — API may still evolve before 1.0.
 *
 * A lightweight reference to a maker (creator), as embedded in app/comment
 * rows. The full card is {@link MakerSummary}.
 */
export interface MakerRef {
  handle: string
  displayName: string
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * One app as it appears in discovery lists, search results, and related/
 * trending rails. Keyed by the canonical `projectId`. `favoritedByViewer` is
 * present (enriched from the optional Bearer) only when a session is attached.
 */
export interface AppSummary {
  projectId: string
  alias: string
  name: string
  tagline: string
  maker: MakerRef
  tags: string[]
  launches: number
  /** Epoch milliseconds the app was first published. */
  publishedAt: number
  theme?: string
  badge?: string
  editorsChoice: boolean
  rating: { average: number; count: number }
  /** 7d-vs-prev-7d launch trend percentage; absent when not computed. */
  trendPct?: number
  /** Present only with an attached session (enriched read). */
  favoritedByViewer?: boolean
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * The full app detail returned by `explore.getApp`: an {@link AppSummary} plus
 * the maker's note and the remix lineage count.
 */
export type AppDetail = AppSummary & {
  makersNote?: string
  remixCount: number
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * A maker (creator) card as returned by `explore.search` and the maker-profile
 * header. `followedByViewer` is present only with an attached session.
 */
export interface MakerSummary {
  handle: string
  displayName: string
  picture?: string
  bio?: string
  location?: string
  link?: string
  appCount: number
  totalLaunches: number
  /** Present only with an attached session (enriched read). */
  followedByViewer?: boolean
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * The single editorial spotlight slot returned by `explore.spotlight`
 * (ops-seeded CMS-lite).
 */
export interface SpotlightItem {
  projectId: string
  kicker: string
  headline: string
  blurb: string
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * One editorial collection as returned by `explore.collections` (ops-seeded
 * CMS-lite).
 */
export interface CollectionInfo {
  id: string
  title: string
  blurb: string
  tags: string[]
  theme?: string
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * A tag with its app count, as returned by `explore.tags`.
 */
export interface TagCount {
  tag: string
  count: number
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * One comment (or reply) on an app. The base shape used both for top-level
 * comments (see {@link CommentNode}) and for their replies. `createdAt` is
 * epoch milliseconds.
 */
export interface CommentReply {
  id: string
  author: MakerRef
  body: string
  createdAt: number
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * A top-level comment with its (single-level) replies. Nesting is exactly one
 * level deep — replies have no further `replies` — and this is server-enforced.
 */
export type CommentNode = CommentReply & {
  replies: CommentReply[]
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * One favorite/follow edge as returned by `profile.myFavorites`. The single
 * edge table models both favorites (`targetKind: 'app'`) and follows
 * (`targetKind: 'creator'`); `targetId` is the canonical app `projectId` or the
 * creator `handle` accordingly. `createdAt` is epoch milliseconds.
 */
export interface FavoriteEdge {
  targetKind: 'creator' | 'app'
  targetId: string
  createdAt: number
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * The viewer's notification toggles, read/written by
 * `profile.getNotificationPrefs` / `profile.setNotificationPrefs`.
 */
export interface NotificationPrefs {
  comments: boolean
  remixes: boolean
  followers: boolean
  weeklyDigest: boolean
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * Sort order for `explore.listApps`. `'popular'` ranks by launches,
 * `'new'` by `publishedAt`, `'trending'` by the 7d-vs-prev-7d trend.
 */
export type AppSort = 'popular' | 'new' | 'trending'
