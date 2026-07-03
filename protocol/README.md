# @mythwork/protocol

Wire protocol v1 for the Mythwork host ↔ inner-app postMessage channel.
This package is the spec: it defines every message shape, every RPC method, and
every push event as TypeScript types, plus the constants the handshake and
transport rely on.

**There is no version negotiation on the wire.** `oc-init` carries no version
field; `PROTOCOL_VERSION = 1` is exported for documentation only. Adding a
negotiation field is a host-side follow-up, not part of this contract.

Zero dependencies. Runtime code is constants only.

---

## Handshake sequence

```
inner app                         host frame
   │                                   │
   │── postMessage({ type:'oc-ping' }) ──▶│   (every 100 ms, up to 5 s)
   │                                   │
   │◀── postMessage({ type:'oc-init',  │
   │       shareBaseOrigin }, [port]) ──│   (transfers MessagePort)
   │                                   │
   │  port installed at window.__oc.port  │
   │  'ocready' event dispatched          │
   │                                   │
   │═══════ all RPC + push traffic ════════▶
```

| Constant | Value | Meaning |
|---|---|---|
| `OC_PING` | `'oc-ping'` | Message type the inner app sends to the host |
| `OC_INIT` | `'oc-init'` | Message type the host replies with, transferring the port |
| `PING_INTERVAL_MS` | `100` | Milliseconds between successive pings |
| `PING_BUDGET_MS` | `5000` | Total handshake budget before giving up |
| `OC_PORT_GLOBAL` | `'__oc'` | `window` property where the port is installed (`window.__oc.port`) |
| `DEFAULT_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout if the caller does not specify one |
| `PROTOCOL_VERSION` | `1` | Documentation marker; not transmitted on the wire |

The `oc-init` message body also carries `shareBaseOrigin`: the host-frame origin
string the inner app may use to construct share links. It does not make requests
to that origin.

---

## Envelope shapes

All traffic after the handshake flows over the transferred `MessagePort`.

### Request (inner app → host)

```ts
{ id: string; method: string; args: Record<string, unknown> }
```

`id` is an opaque correlation token (e.g. an auto-incrementing integer string).
`method` is the wire method string. `args` is the params object. Payloads may
include `Uint8Array` and other structured-clone-able values — this is
`postMessage`, not JSON.

### Response (host → inner app)

```ts
{ id: string; result?: unknown }   // success
{ id: string; error: string }      // failure
```

Exactly one of `result` / `error` is meaningful. On success, `result` holds the
method's typed result. On failure, `error` is a human-readable message string.

### Push (host → inner app)

```ts
{ type: string; [key: string]: unknown }
```

Pushes carry **no `id`**. The `type` field is the event string (a key of
`EventMap`). Subscription is **prefix-matched**: a subscriber registered for
`'fs'` receives both an exact `'fs'` push and any `'fs.*'` push (e.g.
`'fs.changed'`); a subscriber to `'fs.changed'` matches only that exact type.

---

> The catalog below (**52 methods**, **8 events**) documents the original
> deployed-v1 surface. A separate **Explore surface** section near the end
> describes the **+21** explore/engagement methods. All **+21** are
> `@experimental` — the API surface may still evolve before 1.0.

## Methods catalog

52 wire methods grouped by namespace. Unless noted, all methods are available
without authentication. "Auth-gated" means the host requires a signed-in session
(it associates a canonical project id before proceeding).

### project.*

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `project.create` | `{ projectName?: string; localId?: string; parentProjectId?: string }` | `ProjectInfo` | Creates a local-first project; canonical id provisioned lazily on first signed-in server op |
| `project.open` | `{ pid: string }` | `ProjectInfo` | Open by localId or canonical id; returned `pid` is always the local registry key |
| `project.close` | `{ pid: string }` | `Ok` | Drain resources and registry entry |
| `project.list` | `{}` | `{ pids: string[] }` | All project ids this device knows about |
| `project.delete` | `{ pid: string }` | `Ok` | Permanently delete local data |
| `project.rename` | `{ pid: string; newName: string }` | `Ok` | Updates on-disk config + name cache |
| `project.getName` | `{ pid: string }` | `{ name: string \| null }` | Cached display name; `null` if config not yet on disk |
| `project.getNames` | `{ pids: string[] }` | `{ names: Record<string, string \| null> }` | Batch version of `project.getName` |
| `project.getDescription` | `{ pid: string }` | `{ description: string \| null }` | Cached top-level package.json `description`; `null` when unset or config not yet on disk |
| `project.setDescription` | `{ pid: string; description: string }` | `Ok` | Sets the top-level package.json `description` (empty string clears it); indexed for search on next publish |
| `project.setPublicCollab` | `{ pid: string; enabled: boolean }` | `{ projectId: string; publicCollab: boolean }` | Auth-gated; local-only/anonymous project rejects |

### fs.* — file operations

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `fs.read` | `{ pid: string; path: string }` | `Uint8Array` | Rejects if file does not exist |
| `fs.write` | `{ pid: string; path: string; bytes: Uint8Array }` | `Ok` | Create or overwrite |
| `fs.list` | `{ pid: string; prefix?: string }` | `string[]` | All file paths, optionally filtered by prefix |
| `fs.exists` | `{ pid: string; path: string }` | `{ exists: boolean }` | |
| `fs.rename` | `{ pid: string; from: string; to: string }` | `Ok` | Move/rename |
| `fs.delete` | `{ pid: string; path: string }` | `Ok` | |

### fs.* — git operations

These share the `fs.*` wire prefix but route to the git bridge. The four
write operations are **auth-gated** (they associate a canonical project id first).

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `fs.commit` | `{ pid: string; message: string; author?: CommitAuthor }` | `{ sha: string }` | Auth-gated |
| `fs.log` | `{ pid: string; depth?: number; skip?: number }` | `CommitInfo[]` | Newest first; paginated by `depth`/`skip` |
| `fs.showVersion` | `{ pid: string; shaLike: string; path: string }` | `Uint8Array` | `shaLike` accepts HEAD, HEAD~N, sha, refs |
| `fs.diff` | `{ pid: string; sha?: string }` | `DiffEntry[]` | Working-tree diff; or against `sha` if given |
| `fs.checkout` | `{ pid: string; shaLike: string }` | `Ok` | |
| `fs.head` | `{ pid: string }` | `string \| null` | Current HEAD sha; `null` on unborn HEAD |
| `fs.hasUncommittedChanges` | `{ pid: string }` | `{ dirty: boolean }` | |
| `fs.commitTree` | `{ pid: string; sourceSha: string; message: string; author?: CommitAuthor }` | `{ sha: string }` | Auth-gated; copy-forward, history preserved |
| `fs.deleteCommit` | `{ pid: string; sha: string }` | `{ newHead: string }` | Auth-gated; refuses the initial commit |
| `fs.editCommitMessage` | `{ pid: string; sha: string; newMessage: string }` | `Ok` | Auth-gated; refuses the initial commit |
| `fs.flushDirty` | `{ pid: string }` | `Ok` | Flush dirty in-memory docs to filesystem |

### collab.*

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `collab.openRoom` | `{ pid: string; name: string; scope?: 'project' \| 'app'; projectName?: string }` | `RoomDescriptor` | `scope` defaults to `'project'`; `'global'` is rejected; server room requires association (auth-gated indirectly); local-only project yields `local:<scope>:<name>` descriptor |

### config.*

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `config.get` | `{ pid: string }` | `ProjectConfig` | Always carries `projectId` (registry; falls back to `pid` when local-only); display fields from `package.json` `mythwork` |

### secrets.*

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `secrets.check` | `{ pid: string; name: string }` | `{ isSet: boolean }` | Never reveals the secret value |
| `secrets.proxyFetch` | `{ pid: string; url: string; options?: { method?: string; headers?: Record<string, string>; body?: string } }` | `{ status: number; headers: Record<string, string>; body: string }` | Substitutes `{{SECRET}}` placeholders at the edge; browser never sees secret values |

### ydocs.* — @internal

Apps normally reach Yjs persistence through the `y-indexeddb` shim rather than
calling these directly.

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `ydocs.append` | `{ pid: string; docName: string; update: Uint8Array }` | `Ok` | @internal Append a Yjs update to the log |
| `ydocs.getAll` | `{ pid: string; docName: string }` | `Uint8Array[]` | @internal Full update log for a doc |
| `ydocs.snapshot` | `{ pid: string; docName: string; snapshotBytes: Uint8Array }` | `Ok` | @internal Atomically compact the log to a single snapshot |
| `ydocs.clear` | `{ pid: string; docName: string }` | `Ok` | @internal Drop a doc's entire update store |

### profile.*

Reads are public (no auth required). Mutations are **consent-gated**: the host
renders a confirmation dialog the app cannot spoof. Mutation results use
`ProfileMutationResult` (`{ ok: false; reason: string }` on denial/conflict, or
the success shape) rather than throwing.

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `profile.get` | `{ handle: string }` | `{ exists: false } \| (Record<string, unknown> & { exists?: true })` | 404 resolves to `{ exists: false }` |
| `profile.discover` | `{}` | `Record<string, unknown>` | Top creators + top apps by favorites |
| `profile.claimHandle` | `{ handle: string }` | `ProfileMutationResult` | Auth-gated + consent-gated; 409 → `{ ok: false, reason: 'handle_taken' }` |
| `profile.setContentProject` | `{ projectId: string }` | `ProfileMutationResult` | Auth-gated + consent-gated |
| `profile.publish` | `{ pid: string; handle: string }` | `{ ok: false; reason: string } \| { canonical: string; alias: string \| null }` | Consent-gated; delegates to `publish.run` on allow |
| `profile.setFavorite` | `{ targetKind: 'creator' \| 'app'; targetId: string }` | `{ ok: false; reason: string } \| { ok: true; favorited: boolean; count: number }` | Not consent-gated (reversible, self-scoped) |

### publish.*

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `publish.run` | `{ pid: string; shortName: string }` | `{ canonical: string; alias: string \| null }` | Auth-gated; emits `publish.progress` pushes; `alias` is `null` when none advanced |

### kernel.*

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `kernel.getUser` | `{}` | `User` | Returns anonymous sentinel when signed out |
| `kernel.signIn` | `{}` | `User` | Opens Google OAuth popup if needed; also fires `kernel.authChanged` push |
| `kernel.signOut` | `{}` | `User` | Resolves optimistically; `kernel.authChanged` push reconfirms |

### event.*

Generic event ingest (error reports today, usage analytics planned). The host
bridge stamps the trusted appId and viewer auth server-side — apps cannot
supply or spoof attribution.

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `event.sendBatch` | `{ batch: Record<string, unknown>[] }` | `Ok` | Best-effort: the host forwards the batch server-side and always resolves `Ok`, even if the forward fails. Caps (server-enforced): `batch` ≤ 100 items; each item a JSON object whose serialization is ≤ 8KB of UTF-8 bytes — a violating item is dropped and counted server-side, never fatal to the rest of the batch |

### db.* — @internal

Apps normally reach key-value storage through higher-level store helpers rather
than calling these directly.

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `db.put` | `{ store: string; key: string; value: unknown }` | `null` | @internal |
| `db.get` | `{ store: string; key: string }` | `unknown` | @internal |
| `db.getAll` | `{ store: string }` | `{ key: string; value: unknown }[]` | @internal |
| `db.delete` | `{ store: string; key: string }` | `null` | @internal |
| `db.sync` | `{}` | `null` | @internal Force a cloud-sync queue flush |

---

## Events catalog

8 push events. All are id-less `PushMessage`s; the payload is the message minus
the `type` field.

| Wire type | Payload fields | Notes |
|---|---|---|
| `fs.changed` | `{ pid: string; path: string; kind: 'created' \| 'updated' \| 'deleted' }` | File changed in the project |
| `project.lifecycle` | `{ kind: 'project:opened' \| 'project:closed' \| 'project:created' \| 'project:deleted'; pid: string }` or `{ kind: 'project:renamed'; pid: string; newName: string }` or `{ kind: 'project:leader-changed'; pid: string }` | Project lifecycle transition; `newName` present only on `'project:renamed'` |
| `project.associated` | `{ pid: string; projectId: string }` | Local-only project gained a canonical id; app can upgrade its URL |
| `project.namesChanged` | `{ pid: string; name: string \| null }` | Display name updated (e.g. via collab sync); `null` when config transiently yields no name |
| `project.descriptionChanged` | `{ pid: string; description: string \| null }` | Top-level package.json `description` updated (e.g. via collab sync or `project.setDescription`); `null` when unset |
| `db.change` | `{ store: string; key: string; value: unknown; deleted: boolean }` | @internal Key-value store entry changed; `value` is `null` and `deleted` is `true` on delete |
| `kernel.authChanged` | `{ user: User }` | Auth state changed (sign-in, sign-out, identity update) |
| `publish.progress` | `{ pid: string; state: 'publishing' \| 'published' \| 'error'; canonical?: string; alias?: string \| null; error?: string }` | Coarse publish progress for a `publish.run`; `canonical`/`alias` set on `'published'`; `error` set on `'error'` |

---

## Data types

| Type | Description |
|---|---|
| `User` | Discriminated union on `kind`: `'anonymous'` (sentinel), `'pseudonymous'` (project-scoped display name), `'public'` (avatar + profile URL) |
| `CommitAuthor` | `{ name: string; email: string }` — author override for git write methods |
| `CommitInfo` | `{ sha, message, timestamp: Date, author, authorEmail }` — one commit from `fs.log`; `timestamp` is a real `Date` (structured clone) |
| `DiffEntry` | `{ filepath, status: 'added' \| 'modified' \| 'deleted', hunks: DiffHunk[] }` — one changed file from `fs.diff` |
| `DiffHunk` | `{ oldStart, oldCount, newStart, newCount, lines: DiffLine[] }` |
| `DiffLine` | `{ type: 'add' \| 'delete' \| 'context'; content: string }` |
| `RoomDescriptor` | `{ roomId, serverUrl, joinToken? }` — from `collab.openRoom`; `joinToken` absent for local-only projects |
| `ProjectInfo` | `{ pid: string; role: 'leader' \| 'follower' }` — from `project.create`/`project.open` |
| `ProjectConfig` | `{ projectId: string } & Record<string, unknown>` — `projectId` from the registry; display fields from `package.json` `mythwork` |
| `Ok` | `{ ok: true }` — trivial success acknowledgement |
| `ProfileMutationResult` | `{ ok: false; reason: string } \| (Record<string, unknown> & { ok?: true })` — profile mutation result |

---

## Explore surface

> **`@experimental` — kept separate from the original deployed-v1 catalog above
> on purpose.** The methods and types in this section back the explore /
> engagement backend. The one exception is **`project.remix`**, which still has
> **no bridge** and is **not yet served**. The v1 catalog above documents the
> original surface (**52 methods**, **8 events**); this section adds **+21
> methods** and the data types they use. Everything here stays `@experimental`
> — the API surface may still evolve before 1.0.

Conventions for this surface:

- Discovery operates on **canonical project ids** (param `projectId`, never
  `pid`).
- **Timestamps** are epoch milliseconds as `number` (field suffix `At`).
- **Pagination:** `{ cursor?: string }` param → `{ items: T[]; nextCursor?:
  string }` result (`nextCursor` absent on the last page).
- All explore reads are **public/anonymous-OK** (an attached Bearer enriches
  rows: `favoritedByViewer`, my rating, …). Engagement writes and `/me`-style
  reads are **signed-in** (gated host-side); noted per method below.

### Methods (+21)

#### explore.* (14)

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `explore.listApps` | `{ tags?: string[]; sort?: AppSort; maker?: string; cursor?: string }` | `{ items: AppSummary[]; nextCursor?: string }` | Public; enriched with session. Backing: projects + app_meta + app_tags + app_stats + profiles |
| `explore.getApp` | `{ projectId: string }` | `AppDetail` | Public; enriched with session. `remixCount` via `projects.forked_from_project_id` |
| `explore.relatedApps` | `{ projectId: string }` | `{ items: AppSummary[] }` | Public. Backing: app_tags |
| `explore.trendingApps` | `{}` | `{ items: AppSummary[] }` | Public. Backing: app_stats (7d vs prev-7d) |
| `explore.tags` | `{}` | `{ items: TagCount[] }` | Public. Backing: app_tags |
| `explore.search` | `{ q: string }` | `{ apps: AppSummary[]; makers: MakerSummary[] }` | Public; `@handle` / `#tag` operators server-side. Backing: app_meta + profiles |
| `explore.popularSearches` | `{}` | `{ items: string[] }` | Public. Backing: editorial row / tiny table |
| `explore.spotlight` | `{}` | `{ item: SpotlightItem \| null }` | Public; `item` is `null` until the slot is seeded. Backing: editorial_spotlight (ops-seeded) |
| `explore.collections` | `{}` | `{ items: CollectionInfo[] }` | Public. Backing: editorial_collections (ops-seeded) |
| `explore.rate` | `{ projectId: string; stars: 1 \| 2 \| 3 \| 4 \| 5 }` | `Ok \| { ok: false; reason: string }` | **Signed-in** (signed-out → `{ ok: false, reason: 'sign_in_required' }`, zero network). Backing: ratings D1 (aggregated into app_stats) |
| `explore.clearRating` | `{ projectId: string }` | `Ok \| { ok: false; reason: string }` | **Signed-in;** re-clicking the current star clears. Backing: ratings D1 |
| `explore.myRatings` | `{}` | `{ ratings: Record<string, number> } \| { ok: false; reason: string }` | **Signed-in;** `projectId` → stars. Backing: ratings D1 |
| `explore.comments` | `{ projectId: string; cursor?: string }` | `{ items: CommentNode[]; nextCursor?: string }` | Public; newest first, one nesting level. Backing: comments D1 |
| `explore.addComment` | `{ projectId: string; body: string; parentCommentId?: string }` | `CommentNode \| { ok: false; reason: string }` | **Signed-in;** `parentCommentId` present = reply (cannot nest further). Backing: comments D1 |

#### profile.* (6 additions)

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `profile.me` | `{}` | own profile (open shape, `handle` + `isOwner: true` guaranteed) \| `{ ok: false; reason: string }` | **Signed-in (gated-result).** The viewer's own profile from the session: `profile.get` shape + the editable fields `profile.update` writes. `no_profile` when unclaimed. Backing: profiles D1 |
| `profile.myFavorites` | `{ targetKind?: 'creator' \| 'app' }` | `{ items: FavoriteEdge[] }` | **Signed-in;** reads the same edge table `profile.setFavorite` writes (favorites + follows). Backing: favorites D1 |
| `profile.update` | `{ displayName?: string; bio?: string; location?: string; link?: string }` | `ProfileMutationResult` | **Signed-in;** server owns link normalization. Backing: profiles columns |
| `profile.getNotificationPrefs` | `{}` | `NotificationPrefs` | **Signed-in.** Backing: notification_prefs D1 |
| `profile.setNotificationPrefs` | `Partial<NotificationPrefs>` | `NotificationPrefs` | **Signed-in;** returns the full updated prefs. Backing: notification_prefs D1 |
| `profile.submitClaim` | `{ name: string; email: string; handle: string; acceptedTerms: true; survey?: Record<string, unknown> }` | `Ok \| { ok: false; reason: string }` | **Signed-in (gated-result).** One authed call: lead fields + the real platform handle (different handle = atomic rename; handle claim runs before the lead upsert, retry-safe); `survey` is an opaque app blob. Backing: claims + profiles D1 |

#### project.* (1 addition — draft, not yet served)

> **`project.remix` has no host bridge yet** — it is the one method in this
> section that no deployed host serves. Calling it against a current host
> rejects. It stays in the contract so apps can compile against it today.

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `project.remix` | `{ projectId: string }` | `ProjectInfo` | **Draft — not yet served (no bridge).** **Signed-in;** fork via CAS ref-copy of the source head tree; result is the caller's new local handle (`{ pid, role }`). Backing: blob/CAS + projects D1 |

> No new events. Live counters (`explore.statsChanged`, `explore.commentAdded`)
> are possible future pushes; v1 polls.

### Data types

| Type | Description |
|---|---|
| `MakerRef` | `{ handle: string; displayName: string }` — lightweight maker reference embedded in app/comment rows |
| `AppSummary` | `{ projectId, alias, name, tagline, description: string \| null, maker: MakerRef, tags: string[], launches, publishedAt, theme?, badge?, editorsChoice, rating: { average, count }, trendPct?, favoritedByViewer? }` — one app in discovery lists; `description` is the published top-level package.json `description` (`null` when none); `favoritedByViewer` present only with a session |
| `AppDetail` | `AppSummary & { makersNote?: string; remixCount: number }` — full app detail from `explore.getApp` |
| `MakerSummary` | `{ handle, displayName, picture?, bio?, location?, link?, appCount, totalLaunches, followedByViewer? }` — maker card; `followedByViewer` present only with a session |
| `SpotlightItem` | `{ projectId, kicker, headline, blurb }` — the editorial spotlight slot |
| `CollectionInfo` | `{ id, title, blurb, tags: string[], theme? }` — one editorial collection |
| `TagCount` | `{ tag: string; count: number }` — a tag with its app count |
| `CommentReply` | `{ id, author: MakerRef, body, createdAt }` — one comment/reply; `createdAt` is epoch ms |
| `CommentNode` | `CommentReply & { replies: CommentReply[] }` — top-level comment with one level of replies (server-enforced) |
| `FavoriteEdge` | `{ targetKind: 'creator' \| 'app'; targetId: string; createdAt: number }` — one favorite/follow edge; `targetId` is the app `projectId` or creator `handle` |
| `NotificationPrefs` | `{ comments: boolean; remixes: boolean; followers: boolean; weeklyDigest: boolean }` — the viewer's notification toggles |
| `AppSort` | `'popular' \| 'new' \| 'trending'` — sort order for `explore.listApps` |
