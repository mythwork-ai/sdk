# @mythwork/protocol

Wire protocol v1 for the Mythwork host ↔ inner-app postMessage channel, plus
the per-project database's client-facing wire contract. Each spec is the
source of truth for its own surface: it defines every message shape, method,
and event (or, for the database, every request and response shape) as
TypeScript types, plus the runtime code each side needs to speak it.

**There is no version negotiation on the wire.** `oc-init` carries no version
field; `PROTOCOL_VERSION = 1` is exported for documentation only. Adding a
negotiation field is a host-side follow-up, not part of this contract.

Zero dependencies. Runtime code is mostly constants, plus the small amount of
logic described below and in the contract directory.

## The per-project database wire contract

`src/contract/` holds the client-facing types for a project's own database:
request and response shapes for each verb, entity and schema types, error
codes, and the token compilers and stamping helpers a client needs to speak
the wire format. Each file is exported individually under `./contract/*`
(see `exports` in `package.json`). The prose contract these types implement,
`src/contract/wire-contract-v1.md`, lives in this directory but is excluded
from the published package.

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
| `OC_SIGNIN_GESTURE` | `'oc-signin-gesture'` | Message type the inner app posts on a sign-in click, so the host can open the OAuth popup on the click's own user gesture |
| `PING_INTERVAL_MS` | `100` | Milliseconds between successive pings |
| `PING_BUDGET_MS` | `5000` | Total handshake budget before giving up |
| `OC_PORT_GLOBAL` | `'__oc'` | `window` property where the port is installed (`window.__oc.port`) |
| `DEFAULT_REQUEST_TIMEOUT_MS` | `30000` | Per-request timeout if the caller does not specify one |
| `PROTOCOL_VERSION` | `1` | Documentation marker; not transmitted on the wire |

The `oc-init` message body also carries `shareBaseOrigin`: the host-frame origin
string the inner app may use to construct share links. It does not make requests
to that origin.

`oc-signin-gesture` is the one message besides the handshake that travels on the
window rather than the port, and it is sent for a browser reason. WebKit decides
a popup is user-initiated from a token that lives on the JS stack, and
`MessagePort` delivery does not carry it — so a `kernel.signIn` served over the
port has no gesture to open a window with, and Safari demotes the OAuth popup to
an address-bar icon. `window.postMessage` does forward the token, so the SDK
reports the click that way before it sends the RPC. It is a hint: no id, no
reply, and the RPC still does the work. A host that does not know the message
ignores it and sign-in behaves as it did before.

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
> describes the **+31** explore/engagement/stacks methods. All **+31** are
> `@experimental` — the API surface may still evolve before 1.0.

## Methods catalog

52 wire methods grouped by namespace. Unless noted, all methods are available
without authentication. "Auth-gated" means the host requires a signed-in session
(it associates a canonical project id before proceeding).

### project.*

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `project.create` | `{ projectName?: string; parentProjectId?: string }` | `ProjectInfo` | Creates a project; host draws a canonical id from a pool (zero network) |
| `project.open` | `{ pid: string }` | `ProjectInfo` | Open by canonical id; returned `pid` is the local registry key |
| `project.close` | `{ pid: string }` | `Ok` | Drain resources and registry entry |
| `project.list` | `{}` | `{ pids: string[] }` | All project ids this device knows about |
| `project.delete` | `{ pid: string }` | `Ok` | Permanently delete local data |
| `project.rename` | `{ pid: string; newName: string }` | `Ok` | Updates on-disk config + name cache |
| `project.getName` | `{ pid: string }` | `{ name: string \| null }` | Cached display name; `null` if config not yet on disk |
| `project.getNames` | `{ pids: string[] }` | `{ names: Record<string, string \| null> }` | Batch version of `project.getName` |
| `project.getDescription` | `{ pid: string }` | `{ description: string \| null }` | Cached top-level package.json `description`; `null` when unset or config not yet on disk |
| `project.setDescription` | `{ pid: string; description: string }` | `Ok` | Sets the top-level package.json `description` (empty string clears it); indexed for search on next publish |
| `project.setPublicCollab` | `{ pid: string; enabled: boolean }` | `{ projectId: string; publicCollab: boolean }` | Auth-gated; local-only/anonymous project rejects |
| `project.remix` | `{ projectId: string }` | `ProjectInfo` | **Signed-in;** fork via CAS ref-copy of the source app's PUBLISHED tree (never its live editing head) into a fresh, parentless-commit project; result is the caller's new local handle (`{ pid, role }`). Backing: blob/CAS + projects D1 |

### build.*

`build.applyTheme` and `build.setTitle` change the app a mythcode agent session
is running, addressed by that session's `sessionId`. Nothing is stored, and a
change the running app cannot take yet is held by the host and applied when it
can.

`build.request` is the generic form of those two, for the rest of the routes
mythcode publishes under a job — style groups, element style and text, history,
the database proxy — so a new one of those needs no new wire method. The SDK
does not interpret its `body` or its answer: that contract belongs to mythcode
and the app making the call. `type` names the route under the session's OWN job
and is validated as a relative path — alphabet `[A-Za-z0-9._~/-]`, no empty, `.`
or `..` segment — so it cannot leave that job; `query` is encoded by the host
rather than concatenated, and neither the job id nor the build server's URL is
ever the caller's to choose. A route may HOLD the request until it has something
to say, which is how mythcode notifies the caller of something without a second
push channel; `timeoutMs` bounds that wait (default 30 s, maximum 5 min).

| Method | Params | Result | Notes |
|---|---|---|---|
| `build.applyTheme` | `{ sessionId: string; theme: AppTheme }` | `BuildApplyResult` | Restyles the running app. First-party, signed-in, and a session this app created; a 400 throws `build.applyTheme failed: invalid` |
| `build.setTitle` | `{ sessionId: string; name: string }` | `BuildApplyResult` | Sets the running app's title; `name` trimmed, non-empty, max 200 chars |
| `build.request` | `{ sessionId: string; type: string; method?: BuildRequestMethod; query?: Record<string, string>; body?: unknown; timeoutMs?: number }` | `BuildRequestResult` | Same gates as the two above. `{ ok: true, status, body }` for any success; `{ ok: false, reason, busyForMs? }` otherwise (`busyForMs` as on `BuildApplyResult`; `pending`, `busy`, `not_ready`, `evicted`, `unavailable`, `refused` for another 4xx, `unsupported` for an answer past the 1 MiB cap or in a content type it cannot carry, `timeout` when the wait elapses). An unusable `type`, `method`, `query` or `timeoutMs` throws |

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
| `publish.run` | `{ pid: string; shortName: string; messageCount?: number }` | `{ canonical: string; alias: string \| null }` | Auth-gated; emits `publish.progress` pushes; `alias` is `null` when none advanced; `messageCount` is analytics-only passthrough, never affects what is published, and a bad value never fails the publish |

### kernel.*

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `kernel.getUser` | `{}` | `User` | Returns anonymous sentinel when signed out |
| `kernel.signIn` | `{}` | `User` | Opens Google OAuth popup if needed; also fires `kernel.authChanged` push |
| `kernel.signOut` | `{}` | `User` | Resolves optimistically; `kernel.authChanged` push reconfirms |
| `kernel.platformSignOut` | `{}` | `User` | Ends the platform session; requires the `platformSignOut` grant; resolves only once confirmed, rejects otherwise |

### event.*

Generic event ingest (error reports today, usage analytics planned). The host
bridge stamps the trusted appId and viewer auth server-side — apps cannot
supply or spoof attribution.

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `event.sendBatch` | `{ batch: Record<string, unknown>[] }` | `SendBatchResult` | Best-effort: the host forwards the batch server-side and always resolves, even if the forward fails. Caps (server-enforced): `batch` ≤ 100 items; each item a JSON object whose serialization is ≤ 8KB of UTF-8 bytes — a violating item is dropped and counted server-side, never fatal to the rest of the batch. The result is `Ok` except when a batch carrying a `maker_report` item reached nobody, which resolves `{ ok: true, forwarded: false, reason }` with `reason` either `'sign_in_required'` (no signed-in session, so the report was stored but attributed and forwarded to no one — ask the person to sign in and file again) or `'rate_limited'` (the per-address request throttle refused the batch before reading it, so the report was not stored — ask the person to wait a moment and file again). Do not report either as sent |

### database.* — per-project relational data

Reuses the mythwork wire contract's own request/response types (`src/contract/*`)
rather than restating them — see "The per-project database wire contract" above.
The four reads (`list`/`get`/`count`/`schema`) are enriched reads, same posture
as the explore namespace's reads: an attached session enriches which rows come
back, and a stale-token 401 propagates rather than silently downgrading to
anonymous. The three writes (`create`/`update`/`delete`) are auth-gated: a
signed-out call or a per-row rule denial both reject.

Every verb also takes an optional `projectId`, naming the project to operate
on instead of the caller's own. A generated app never sets it. It exists for
the IDE, which is served as an app with its own fixed project id and would
otherwise never reach the database of the project the maker is building — the
bridge honors a named project only for a first-party caller and refuses it
from anyone else.

Every verb also takes an optional `jobId`, naming the mythcode job to operate
on instead of the one the host's live session registry finds for the
project. Honored under the same first-party rule as `projectId`, and only
when the job belongs to the effective project. It exists because after a
page reload the IDE names the job it already knows from its own build
record, instead of waiting on a new session.

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `database.list` | `{ entity: string; projectId?: string; jobId?: string } & ListQuery` | `PageResult` | List one page of an entity's rows |
| `database.get` | `{ entity: string; id: Id<string>; projectId?: string; jobId?: string }` | `SchemaRow` | Read one row by id |
| `database.count` | `{ entity: string; where?: EntityFilter; projectId?: string; jobId?: string }` | `CountResult` | Count the rows the caller could list |
| `database.create` | `{ entity: string; body: CreateBody; projectId?: string; jobId?: string }` | `SchemaRow` | Create one row; auth-gated |
| `database.update` | `{ entity: string; id: Id<string>; patch: PatchBody; projectId?: string; jobId?: string }` | `SchemaRow` | Patch one row; auth-gated |
| `database.delete` | `{ entity: string; id: Id<string>; projectId?: string; jobId?: string }` | `null` | Delete one row; auth-gated |
| `database.schema` | `{ projectId?: string; jobId?: string }` | `SchemaResponse` | Read the published schema |

---

## Events catalog

8 push events. All are id-less `PushMessage`s; the payload is the message minus
the `type` field.

| Wire type | Payload fields | Notes |
|---|---|---|
| `fs.changed` | `{ pid: string; path: string; kind: 'created' \| 'updated' \| 'deleted' }` | File changed in the project |
| `project.lifecycle` | `{ kind: 'project:opened' \| 'project:closed' \| 'project:created' \| 'project:deleted'; pid: string }` or `{ kind: 'project:renamed'; pid: string; newName: string }` or `{ kind: 'project:leader-changed'; pid: string }` | Project lifecycle transition; `newName` present only on `'project:renamed'` |
| `project.namesChanged` | `{ pid: string; name: string \| null }` | Display name updated (e.g. via collab sync); `null` when config transiently yields no name |
| `project.descriptionChanged` | `{ pid: string; description: string \| null }` | Top-level package.json `description` updated (e.g. via collab sync or `project.setDescription`); `null` when unset |
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
| `AppTheme` | `{ style: AppThemeStyle \| GeneratedStyleId; hue: number; secondaryHue?: number; mode: 'light' \| 'dark' }` — an app's visual theme; `style` is a builtin preset (`isAppThemeStyle`) or a preset the session's current job generated and offered in `build-suggestions` (`isGeneratedStyleId`, shape only), `hue` is degrees |
| `BuildApplyResult` | `{ applied: true } \| { applied: false; reason: BuildApplyReason; busyForMs?: number }` — what a `build.*` call did; nothing is stored, so a refusal always says why. `busyForMs` (how long the turn holding the app has been running) may be set on `busy`: present when the host's own turn refused, absent when the build server answered busy |
| `BuildApplyReason` | `'pending' \| 'busy' \| 'not_ready' \| 'evicted' \| 'unavailable' \| 'unknown_style'` — no app yet, applied at the first preview; a turn is running, applied when it finishes; the app has no files yet, retry; the app was reopened, applied on the new job; the build server did not answer, retry; a generated style the current job did not produce or no longer has (evicted, replaced, build server restarted, or no job yet), not held — pick again from the current job's suggestions |
| `ProjectConfig` | `{ projectId: string } & Record<string, unknown>` — `projectId` from the registry; display fields from `package.json` `mythwork` |
| `Ok` | `{ ok: true }` — trivial success acknowledgement |
| `ProfileMutationResult` | `{ ok: false; reason: string } \| (Record<string, unknown> & { ok?: true })` — profile mutation result |

---

## Explore surface

> **`@experimental` — kept separate from the original deployed-v1 catalog above
> on purpose.** The methods and types in this section back the explore /
> engagement backend. The v1 catalog above documents the original surface
> (**52 methods**, **8 events**); this section adds **+31 methods** and the
> data types they use. Everything here stays `@experimental` — the API
> surface may still evolve before 1.0.

Conventions for this surface:

- Discovery operates on **canonical project ids** (param `projectId`, never
  `pid`).
- **Timestamps** are epoch milliseconds as `number` (field suffix `At`).
- **Pagination:** `{ cursor?: string }` param → `{ items: T[]; nextCursor?:
  string }` result (`nextCursor` absent on the last page).
- All explore reads are **public/anonymous-OK** (an attached Bearer enriches
  rows: `favoritedByViewer`, my rating, …). Engagement writes and `/me`-style
  reads are **signed-in** (gated host-side); noted per method below.

### Methods (+31)

#### explore.* (16)

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `explore.listApps` | `{ tags?: string[]; sort?: AppSort; maker?: string; cursor?: string }` | `{ items: AppSummary[]; nextCursor?: string }` | Public; enriched with session. Backing: projects + app_meta + app_tags + app_stats + profiles |
| `explore.getApp` | `{ projectId: string }` | `AppDetail` | Public; enriched with session. `remixCount`/`remixedFrom` via `projects.forked_from_project_id` |
| `explore.relatedApps` | `{ projectId: string }` | `{ items: AppSummary[] }` | Public. Backing: app_tags |
| `explore.listRemixes` | `{ projectId: string; cursor?: string }` | `{ items: AppSummary[]; nextCursor?: string }` | Public; enriched with session. The reverse of `getApp`'s `remixedFrom`. Backing: `projects.forked_from_project_id` (reverse index) joined to apps |
| `explore.trendingApps` | `{}` | `{ items: AppSummary[] }` | Public. Backing: app_stats (7d vs prev-7d) |
| `explore.tags` | `{}` | `{ items: TagCount[] }` | Public. Backing: app_tags |
| `explore.search` | `{ q: string }` | `{ apps: AppSummary[]; makers: MakerSummary[] }` | Public; `@handle` / `#tag` operators server-side. Backing: app_meta + profiles |
| `explore.popularSearches` | `{}` | `{ items: string[] }` | Public. Backing: editorial row / tiny table |
| `explore.spotlight` | `{}` | `{ item: SpotlightItem \| null }` | Public; `item` is `null` until the slot is seeded. Backing: editorial_spotlight (ops-seeded) |
| `explore.collections` | `{}` | `{ items: CollectionInfo[] }` | Public. Backing: editorial_collections (ops-seeded) |
| `explore.rate` | `{ projectId: string; stars: 1 \| 2 \| 3 \| 4 \| 5 }` | `Ok \| { ok: false; reason: string }` | **Signed-in** (signed-out → `{ ok: false, reason: 'sign_in_required' }`, zero network). Backing: ratings D1 (aggregated into app_stats) |
| `explore.clearRating` | `{ projectId: string }` | `Ok \| { ok: false; reason: string }` | **Signed-in;** re-clicking the current star clears. Backing: ratings D1 |
| `explore.myRatings` | `{}` | `{ ratings: Record<string, number> } \| { ok: false; reason: string }` | **Signed-in;** `projectId` → stars. Backing: ratings D1 |
| `explore.myApps` | `{ cursor?: string; projectId?: string; q?: string }` | `{ items: MyAppSummary[]; nextCursor?: string } \| { ok: false; reason: string }` | **Signed-in; first-party apps only;** the viewer's own apps — published, unpublished, and scan-gate-restricted — flagged (`unpublished`/`restricted`) rather than filtered. Scoped only to the caller's own `publisher_user_id`. `q` substring-filters the effective name/tagline (not the FTS index, which omits drafts). Backing: apps D1 |
| `explore.setPinned` | `{ projectId: string; pinned: boolean }` | `Ok \| { ok: false; reason: string }` | **Member-gated (any role); first-party apps only;** pins the project in the caller's OWN list — a per-user display preference on their own `user_prefs` row, so it changes nothing another member sees. Idempotent; capped at 50 pins per user. Backing: `user_prefs.pinned_project_ids` (JSON array, one row per user; migration 0032) |
| `explore.comments` | `{ projectId: string; cursor?: string }` | `{ items: CommentNode[]; nextCursor?: string }` | Public; newest first, one nesting level. Backing: comments D1 |
| `explore.addComment` | `{ projectId: string; body: string; parentCommentId?: string }` | `CommentNode \| { ok: false; reason: string }` | **Signed-in;** `parentCommentId` present = reply (cannot nest further). Backing: comments D1 |

#### stacks.* (9)

Signed-in-scoped app collections, replacing the frontend's localStorage-only `stacksStore.ts`. Membership is many-to-many (an app can belong to more than one stack); `foldedCategoryIds`/`categoryId` are opaque, frontend-owned routing hints — the category taxonomy itself isn't a backend concept. A stack's own `stackId` IS its share link — no separate token. `visibility` (default `'public'`) gates both `stacks.discover` and `stacks.resolveShare`: `'private'` excludes a stack from discovery AND makes resolveShare refuse anyone but the owner, checked live so flipping a stack private instantly revokes every previously-shared link. `stacks.resolveShare` and `stacks.discover` are the two public/anon-OK reads in this namespace — every other method requires a session.

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `stacks.list` | `{}` | `{ items: StackSummary[] }` | **Signed-in** (throws on both axes — private data, no anonymous variant). Unpaged. Backing: stacks + stack_items |
| `stacks.create` | `{ name: string; kind?: StackKind; foldedCategoryIds?: string[]; visibility?: StackVisibility }` | `StackSummary \| { ok: false; reason: string }` | **Signed-in (gated-result).** `kind` defaults `'custom'`; `visibility` defaults `'public'` |
| `stacks.rename` | `{ stackId: string; name: string }` | `Ok \| { ok: false; reason: string }` | **Signed-in (gated-result); owner-gated** |
| `stacks.delete` | `{ stackId: string }` | `Ok \| { ok: false; reason: string }` | **Signed-in (gated-result); owner-gated;** cascades stack_items |
| `stacks.addApp` | `{ stackId: string; projectId: string; categoryId?: string }` | `Ok \| { ok: false; reason: string }` | **Signed-in (gated-result); owner-gated;** upserts the membership edge |
| `stacks.removeApp` | `{ stackId: string; projectId: string }` | `Ok \| { ok: false; reason: string }` | **Signed-in (gated-result); owner-gated;** idempotent no-op if absent |
| `stacks.splitOutCategory` | `{ hostStackId: string; categoryId: string; newStackName: string; threshold: number }` | `{ graduated: false } \| { graduated: true; stack: StackSummary }` | **Signed-in (gated-result); owner-gated.** Atomic multi-item move; below-threshold and not-owned both collapse to `{ graduated: false }` |
| `stacks.resolveShare` | `{ stackId: string }` | `SharedStack` | **Public**, visibility-gated: refuses (404) a `'private'` stack for a non-owner. Unknown stackId → uniform 404 that the bridge THROWS (existence-hiding, same posture as `explore.getApp`). `items` excludes any app no longer currently visible |
| `stacks.discover` | `{ cursor?: string; limit?: number }` | `{ items: StackSummary[]; nextCursor?: string }` | **Public.** Cursor-paginated listing of `visibility: 'public'` stacks across all owners, newest first |

#### profile.* (6 additions)

| Wire method | Params | Result | Notes |
|---|---|---|---|
| `profile.me` | `{}` | own profile (open shape, `handle` + `isOwner: true` guaranteed) \| `{ ok: false; reason: string }` | **Signed-in (gated-result).** The viewer's own profile from the session: `profile.get` shape + the editable fields `profile.update` writes. `no_profile` when unclaimed. Backing: profiles D1 |
| `profile.myFavorites` | `{ targetKind?: 'creator' \| 'app' }` | `{ items: FavoriteEdge[] }` | **Signed-in;** reads the same edge table `profile.setFavorite` writes (favorites + follows). Backing: favorites D1 |
| `profile.update` | `{ displayName?: string; bio?: string; location?: string; link?: string }` | `ProfileMutationResult` | **Signed-in;** server owns link normalization. Backing: profiles columns |
| `profile.getNotificationPrefs` | `{}` | `NotificationPrefs` | **Signed-in.** Backing: notification_prefs D1 |
| `profile.setNotificationPrefs` | `Partial<NotificationPrefs>` | `NotificationPrefs` | **Signed-in;** returns the full updated prefs. Backing: notification_prefs D1 |
| `profile.getAnalyticsConsent` | `{}` | `{ analytics: AnalyticsConsent \| null }` | **Signed-in; first-party apps only** (the host and the api both check the first-party token). `null` = no choice recorded. Backing: user_prefs D1 |
| `profile.setAnalyticsConsent` | `{ analytics: AnalyticsConsent }` | `{ analytics: AnalyticsConsent }` | **Signed-in; first-party apps only.** Overwrites any earlier choice. Backing: user_prefs D1 |
| `profile.getDiscord` | `{}` | `DiscordLink` | **Signed-in; first-party apps only.** `{ linked, username? }`. Backing: users D1 |
| `profile.linkDiscord` | `{}` | `DiscordLink` | **Signed-in; first-party apps only.** Host dialog, then Discord's sign-in window; resolves with the stored link when the window closes. A Discord account links to one account at a time |
| `profile.unlinkDiscord` | `{}` | `{ linked: false }` | **Signed-in; first-party apps only.** |
| `profile.submitClaim` | `{ name: string; email: string; handle: string; acceptedTerms: true; survey?: Record<string, unknown> }` | `Ok \| { ok: false; reason: string }` | **Signed-in (gated-result).** One authed call: lead fields + the real platform handle (different handle = atomic rename; handle claim runs before the lead upsert, retry-safe); `survey` is an opaque app blob. Backing: claims + profiles D1 |

> No new events. Live counters (`explore.statsChanged`, `explore.commentAdded`)
> are possible future pushes; v1 polls.

### Data types

| Type | Description |
|---|---|
| `MakerRef` | `{ handle: string; displayName: string }` — lightweight maker reference embedded in app/comment rows |
| `AppSummary` | `{ projectId, alias, name, tagline, description: string \| null, maker: MakerRef, tags: string[], launches, publishedAt, theme?, badge?, editorsChoice, rating: { average, count }, trendPct?, favoritedByViewer? }` — one app in discovery lists; `description` is the published top-level package.json `description` (`null` when none); `favoritedByViewer` present only with a session |
| `AppDetail` | `AppSummary & { makersNote?: string; remixCount: number; remixedFrom: { projectId: string; name: string } \| null }` — full app detail from `explore.getApp`; `remixedFrom` is `null` for an organic app or a non-visible parent (existence-hiding) |
| `MyAppSummary` | `AppSummary & { status: 'draft' \| 'live' \| 'unpublished'; restricted: boolean; updatedAt: number; pinned: boolean }` — one app in the viewer's own `explore.myApps` list; `status`/`restricted` replace the filtering the public listing applies, and `updatedAt` is the project's last-touched time (bumped every commit — the recency this list is already ordered by, which `publishedAt` cannot express for a draft); `pinned` is whether THIS viewer pinned it |
| `MakerSummary` | `{ handle, displayName, picture?, bio?, location?, link?, appCount, totalLaunches, followedByViewer? }` — maker card; `followedByViewer` present only with a session |
| `SpotlightItem` | `{ projectId, kicker, headline, blurb }` — the editorial spotlight slot |
| `CollectionInfo` | `{ id, title, blurb, tags: string[], theme? }` — one editorial collection |
| `TagCount` | `{ tag: string; count: number }` — a tag with its app count |
| `CommentReply` | `{ id, author: MakerRef, body, createdAt }` — one comment/reply; `createdAt` is epoch ms |
| `CommentNode` | `CommentReply & { replies: CommentReply[] }` — top-level comment with one level of replies (server-enforced) |
| `FavoriteEdge` | `{ targetKind: 'creator' \| 'app'; targetId: string; createdAt: number }` — one favorite/follow edge; `targetId` is the app `projectId` or creator `handle` |
| `NotificationPrefs` | `{ comments: boolean; remixes: boolean; followers: boolean; weeklyDigest: boolean }` — the viewer's notification toggles |
| `AppSort` | `'popular' \| 'new' \| 'trending'` — sort order for `explore.listApps` |
| `StackKind` | `'default' \| 'revealed' \| 'custom'` — `'default'`: always-visible starter category. `'revealed'`: spawned on first save or by `stacks.splitOutCategory`. `'custom'`: user-created |
| `StackVisibility` | `'public' \| 'private'` — `'public'` (default) surfaces in `stacks.discover` and resolves for anyone; `'private'` excludes it from discovery and makes `stacks.resolveShare` refuse non-owners |
| `StackSummary` | `{ stackId, name, kind: StackKind, foldedCategoryIds: string[], visibility: StackVisibility, projectIds: string[] }` — one stack from `stacks.list`/`stacks.create`/`stacks.splitOutCategory`/`stacks.discover`; `projectIds` is unpaged current membership; `stackId` itself is the stack's share link |
| `SharedStack` | `{ stackId, name, items: AppSummary[] }` — the public resolved contents from `stacks.resolveShare`; `items` excludes any app no longer currently visible |
