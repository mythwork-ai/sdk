// Pure data types referenced by the method and event maps. These are the
// canonical copies the protocol owns — the package defines its own copy so it
// stays self-contained. Each shape is verified against the live host behavior.

/** Product-approval state for a signed-in user (Approval Status API).
 *  `approved` is the only field the nav strictly needs; timestamps are for
 *  the acceptance funnel. ISO-8601 strings; null until the event occurs.
 *  `inviteCodeHash` is the SHA-256 of the server-derived invite code, present
 *  only for approved-but-not-yet-accepted users (null otherwise). */
export interface UserAccess {
  approved: boolean
  approvedAt: string | null
  acceptedAt: string | null
  inviteCodeHash: string | null
}

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
  | { kind: 'pseudonymous'; userId: string; displayName: string; access: UserAccess }
  | {
      kind: 'public'
      userId: string
      displayName: string
      picture: string
      profileUrl: string
      access: UserAccess
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
 * The project identity + display metadata returned by `config.get` (AGE-97).
 * Always carries a `projectId` — the host's resolved canonical id from the
 * registry, falling back to the open `pid` when the project is still local-only.
 * The display fields (`name`/`tagline`/`theme`/`tags`) come from the app's
 * `package.json` `mythwork` block.
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
  /** The app's published top-level package.json `description`; `null` when the
   *  app has none. Always present (matches the platform AppSummaryDTO). */
  description: string | null
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
 * The tri-state listing status for an app in the signed-in viewer's own
 * My Apps / Shared with me views: `'draft'` (never published), `'live'`
 * (currently public), or `'unpublished'` (taken down, still fully intact).
 */
export type AppStatus = 'draft' | 'live' | 'unpublished'

/**
 * @experimental — API may still evolve before 1.0.
 *
 * One app as it appears in the signed-in viewer's own My Apps view
 * (`explore.myApps`) — an {@link AppSummary} plus the two owner-only status
 * flags the public discovery surface never exposes (it filters these apps
 * out entirely instead).
 */
export type MyAppSummary = AppSummary & {
  /** 'draft' (never published), 'live' (currently public), or 'unpublished' (taken down). */
  status: AppStatus
  /** True when the app is hidden from Discover by the read-time moderation scan gate. */
  restricted: boolean
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * One app as it appears in the signed-in viewer's Shared with me view
 * (`explore.sharedWithMe`) — a {@link MyAppSummary} plus the collaborator's
 * role on the project.
 */
export type SharedAppSummary = MyAppSummary & {
  /** The collaborator's role on this project — always 'editor' or 'viewer' (never 'owner'; owner-role apps live in MyAppSummary/my-apps only). */
  role: 'editor' | 'viewer'
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
 */
export type NotificationCategory = 'comments' | 'remixes' | 'followers' | 'weeklyDigest'

interface NotificationInboxItemBase {
  id: string
  subject: string
  body: string
  read: boolean
  createdAt: number
}

/**
 * @experimental — API may still evolve before 1.0.
 *
 * One row in the viewer's notification inbox. `read` is derived server-side
 * from the stored `read_at` timestamp. `context` is a discriminated union
 * keyed on `category` so a consumer never has to guess field names — see
 * docs/superpowers/specs/2026-07-04-notification-context-enrichment-design.md.
 */
export type NotificationInboxItem =
  | (NotificationInboxItemBase & {
      category: 'comments'
      context: { appKey: string; commentId: string }
    })
  | (NotificationInboxItemBase & {
      category: 'followers'
      context: { followerUserId: string; followerHandle: string; followerDisplayName: string }
    })
  | (NotificationInboxItemBase & {
      /** @experimental — context shape undefined until `project.remix` has a
       *  server handler and a real trigger exists; left untyped deliberately. */
      category: 'remixes'
      context: Record<string, unknown>
    })
  | (NotificationInboxItemBase & { category: 'weeklyDigest'; context: Record<string, never> })

/**
 * @experimental — API may still evolve before 1.0.
 *
 * Sort order for `explore.listApps`. `'popular'` ranks by launches,
 * `'new'` by `publishedAt`, `'trending'` by the 7d-vs-prev-7d trend.
 */
export type AppSort = 'popular' | 'new' | 'trending'

// ── ai.* (mythwork-ai proxy, OpenAI-compatible wire) ─────────────────────────
// @experimental — API may still evolve before 1.0. These mirror the
// chat-completions contract the `mythwork-ai` worker (PR #382) accepts/returns:
// ONE normalized OpenAI shape for both providers. The bridge forwards the
// request verbatim to the worker with the host-held session Bearer — it does
// not reshape it — so these types ARE the wire contract.

/**
 * @experimental One chat message in the OpenAI-compatible request. `content` is
 * a string for plain text, an array of content blocks for multimodal/tool
 * payloads, or `null` for an assistant turn that is purely tool calls.
 * `tool_calls` / `tool_call_id` / `name` carry the OpenAI function-calling
 * fields. Wire field names are snake_case to match the proxy verbatim.
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | unknown[] | null
  tool_calls?: unknown[]
  tool_call_id?: string
  name?: string
}

/**
 * @experimental An OpenAI-style tool definition forwarded to the proxy
 * untouched. Left as an open record because the proxy owns the schema; the SDK
 * does not validate it.
 */
export type OpenAITool = Record<string, unknown>

/**
 * @experimental The OpenAI-compatible chat-completion request body the
 * `mythwork-ai` worker accepts. `model` defaults proxy-side when omitted;
 * `system` is a convenience the proxy folds into the message list; `stream:
 * true` makes the bridge relay text deltas as correlated `ai.delta` pushes and
 * still return the full assembled completion (see `ai.chat`).
 */
export interface ChatCompletionRequest {
  model?: string
  messages: ChatMessage[]
  system?: string | { type: 'text'; text: string }[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: unknown
  thinking?: boolean
}

/**
 * @experimental One choice in a normalized OpenAI chat-completion response. The
 * proxy returns the same shape for every provider, so `message` is a
 * {@link ChatMessage} (assistant role) and `finish_reason` is the OpenAI enum.
 */
export interface ChatCompletionChoice {
  index: number
  message: ChatMessage
  finish_reason: string | null
}

/**
 * @experimental The normalized (non-streamed) OpenAI chat-completion response
 * returned by the `mythwork-ai` worker. `usage` is open because token-accounting
 * fields vary by provider. The success branch keeps the wire shape verbatim so
 * apps that already speak OpenAI can consume it directly.
 */
export interface ChatCompletion {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: ChatCompletionChoice[]
  usage?: Record<string, unknown>
}
