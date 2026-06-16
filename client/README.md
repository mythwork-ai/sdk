# @mythwork/sdk

The Mythwork inner-app client. Install this package in any app hosted on the
Mythwork platform. It handles the host-frame handshake, exposes a fully-typed
`request()` / `subscribe()` interface, and provides namespaced helpers so you
never have to remember legacy wire method strings.

**Requirement:** your app must run inside a Mythwork host frame (served via the
Mythwork platform). Calling `connect()` from a standalone page with no host
frame will reject with `NO_PORT_ERROR`.

---

## Install

```sh
npm install @mythwork/sdk
```

`@mythwork/sdk` re-exports everything from `@mythwork/protocol`, so you only
need this one dependency. v1 ships raw TypeScript source; your bundler (Vite,
esbuild, tsc) compiles it.

---

## Quickstart

```ts
import { connect } from '@mythwork/sdk'

const sdk = await connect()
```

`connect()` performs the host-frame handshake and resolves a ready
`MythworkClient`. If no host port appears within the budget (default 5 s) it
rejects with the message from `NO_PORT_ERROR`.

---

## Examples

### File system — read and write

```ts
const { pid } = await sdk.project.create({ projectName: 'my-app' })

// Write bytes to a file
const encoder = new TextEncoder()
await sdk.fs.write({ pid, path: 'index.html', bytes: encoder.encode('<h1>Hello</h1>') })

// Read bytes back
const bytes = await sdk.fs.read({ pid, path: 'index.html' })
console.log(new TextDecoder().decode(bytes))

// List files
const paths = await sdk.fs.list({ pid })
console.log(paths)
```

### Authentication

```ts
// Get the current user (anonymous sentinel when signed out)
const user = await sdk.auth.getUser()
if (user.kind === 'anonymous') {
  const authed = await sdk.auth.signIn()
  console.log('signed in as', authed.displayName)
}

// Subscribe to auth changes
const off = sdk.auth.onAuthChanged(({ user }) => {
  console.log('auth changed', user.kind)
})
// Later: off() to unsubscribe
```

### Project

```ts
const { pid, role } = await sdk.project.create({ projectName: 'demo' })
console.log(pid, role) // e.g. "abc123", "leader"

// Publish once signed in
const { canonical, alias } = await sdk.project.publish({ pid, shortName: 'my-demo' })
console.log('published at', canonical)
```

### Explore (served by mythwork#296+)

> `@experimental`: the `sdk.explore` namespace is **served by hosts running
> mythwork#296 or later** (the host bridges merged in that PR). The API surface
> may still evolve before 1.0. Against an older host, these calls reject.

```ts
// Browse apps (public; sort defaults host-side)
const { items, nextCursor } = await sdk.explore.listApps({ tags: ['game'], sort: 'trending' })
for (const app of items) console.log(app.name, app.launches)

// Read one app's detail by canonical projectId
const app = await sdk.explore.getApp({ projectId: items[0]!.projectId })

// Engagement (signed-in)
await sdk.explore.rate({ projectId: app.projectId, stars: 5 })
```

### Subscribe to file changes

```ts
const off = sdk.fs.onChanged(({ pid, path, kind }) => {
  console.log(`${path} was ${kind}`)
})
// Later: off() to unsubscribe
```

### Low-level: raw request and subscribe

If a helper does not exist for a wire method, call `request()` directly with the
full wire method string — the call is still fully typed:

```ts
// Typed against MethodMap
const info = await sdk.request('project.getName', { pid })
console.log(info.name)

// Subscribe by wire event type
const off = sdk.subscribe('fs.changed', ({ path, kind }) => {
  console.log(path, kind)
})
```

---

## React (`@mythwork/sdk/react`)

React bindings over the client, so apps don't hand-roll a provider + hooks. Two
layers: a **base** provider every app needs, and a **project** layer editor apps
add on top.

`react`, `yjs`, `y-protocols`, and `y-websocket` are **optional peer
dependencies** — only the `./react` subpath pulls them; the core `@mythwork/sdk`
entry stays dependency-free.

### Base layer — `MythworkProvider` + `useMythwork`

Connect once, resolve the user, expose `{ sdk, user, authStatus, signIn, signOut }`:

```tsx
import { MythworkProvider, useMythwork } from '@mythwork/sdk/react'

function Root() {
  return (
    <MythworkProvider>
      <App />
    </MythworkProvider>
  )
}

function Header() {
  const { user, authStatus, signIn } = useMythwork()
  if (authStatus === 'anonymous') return <button onClick={signIn}>Sign in</button>
  return <span>{user?.kind === 'public' ? user.displayName : 'anon'}</span>
}
```

Un-embedded (a dev server / tests) where `connect()` would hang, inject a
DevHost-backed client via the `connect` seam:

```tsx
<MythworkProvider connect={() => Promise.resolve(new MythworkClient(myDevHostPort))}>
```

`useUser()` is a thin projection of the same context for identity-centric code:
`{ userId, kind, name?, picture?, signIn, signOut }` (`kind: 'pending'` until the
client connects).

### Project layer — `MythworkProjectProvider` + project hooks

Editor apps open a project, then use the project-scoped hooks (they read `pid`
from `useProject()` and the client from `useMythwork()`):

```tsx
import {
  MythworkProjectProvider, useProject, useFiles, useGit, useCollabRoom,
} from '@mythwork/sdk/react'

function Match({ pid }: { pid: string }) {
  return (
    <MythworkProjectProvider pid={pid}>
      <Editor />
    </MythworkProjectProvider>
  )
}

function Editor() {
  const { doc, awareness, status } = useCollabRoom({ name: 'index.html' })
  const files = useFiles()
  const git = useGit()
  // doc/awareness drive a Yjs editor binding (e.g. y-codemirror.next);
  // files.write + git.commit persist; git.log/head drive history.
}
```

- **`useCollabRoom(name | opts)`** → `{ doc, awareness, collaborators, status, syncing, roomId, serverUrl, setAwareness }`. Resolves the room via `sdk.collab.openRoom`, owns the Y.Doc/Awareness/WebsocketProvider (with `?jt=` token). `local: true` binds a zero-network local doc; `noWebsocket` / `instanceId` for tests. (Offline IndexedDB persistence is a planned follow-up — rooms are WS-synced today.)
- **`useFiles(prefix?)`** → live `paths` + `read/write/list/exists/rename/remove`, version-aware `commit/log/showVersion/diff/checkout`, and `subscribe(handler)` for `fs.changed`. `null` while loading.
- **`useGit({ depth? })`** → live `head/log/hasUncommittedChanges` + `commit/checkout/.../show` + `refresh()`. `refresh()` is manual; wire `files.subscribe(() => git.refresh())` to track remote commits. `null` while loading.

---

## Local dev & testing — the built-in dev host

`connect({ dev: true })` connects to an in-SDK dev host (dynamically imported, so
it's tree-shaken from prod builds) — no real host frame, no app-side mock server:

```ts
const sdk = await connect({ dev: import.meta.env.DEV })
```

The dev host answers the full surface over generic seed fixtures:
- **explore / profile / kernel** — discovery, profiles, and auth (sign-in adopts a seeded `devuser`).
- **project / fs / git / collab** — `project.create`/`open`, `fs.*`, the `fs.commit`/`log`/`head`/`showVersion` git ops, and `collab.openRoom`. Project state is **shared per pid across dev clients**, so two `connect({ dev: true })` clients that open the same project share one file tree + commit log and receive each other's `fs.changed` pushes.

### Live collaboration in dev — `installDevCollabRelay()`

`collab.openRoom` returns a shared dev room id, but live `Y.Doc` convergence needs
a transport. In dev/test, install the in-memory relay (from `@mythwork/sdk/react`)
once before mounting collab hooks — two peers sharing a room then converge with no
WebSocket server:

```ts
import { connect } from '@mythwork/sdk'
import { installDevCollabRelay } from '@mythwork/sdk/react'

if (import.meta.env.DEV) installDevCollabRelay()
const sdk = await connect({ dev: true })
```

Together these let an editor app run end-to-end — including two-peer multiplayer
tests — entirely on the SDK, with no platform host. (`createDevHost()` from
`@mythwork/sdk/dev` returns the raw `MessagePort` for advanced/test wiring.)

---

## Namespace → wire mapping

The client presents clean namespaces and maps them to the deployed wire method
strings internally. Legacy strings are never exposed to application code.

| Client namespace | Wire methods / events covered |
|---|---|
| `sdk.project` | `project.*`, `publish.run` (as `sdk.project.publish`) |
| `sdk.fs` | `fs.read`, `fs.write`, `fs.list`, `fs.exists`, `fs.rename`, `fs.delete`; event `fs.changed` |
| `sdk.git` | `fs.commit`, `fs.log`, `fs.showVersion`, `fs.diff`, `fs.checkout`, `fs.head`, `fs.hasUncommittedChanges`, `fs.commitTree`, `fs.deleteCommit`, `fs.editCommitMessage`, `fs.flushDirty` |
| `sdk.collab` | `collab.openRoom` |
| `sdk.store` (@internal) | `db.put`, `db.get`, `db.getAll`, `db.delete`, `db.sync`; event `db.change` |
| `sdk.ydocs` (@internal) | `ydocs.append`, `ydocs.getAll`, `ydocs.snapshot`, `ydocs.clear` |
| `sdk.auth` | `kernel.getUser`, `kernel.signIn`, `kernel.signOut`; event `kernel.authChanged` |
| `sdk.secrets` | `secrets.check`, `secrets.proxyFetch` |
| `sdk.config` | `config.get` |
| `sdk.profile` | `profile.get`, `profile.discover`, `profile.claimHandle`, `profile.setContentProject`, `profile.publish`, `profile.setFavorite` |
| `sdk.profile` (**served by #296+**) | `profile.me` (staging), `profile.myFavorites`, `profile.update`, `profile.getNotificationPrefs`, `profile.setNotificationPrefs` — `@experimental` |
| `sdk.explore` (**served by #296+**) | `explore.listApps`, `explore.getApp`, `explore.relatedApps`, `explore.trendingApps`, `explore.tags`, `explore.search`, `explore.popularSearches`, `explore.spotlight`, `explore.collections`, `explore.rate`, `explore.clearRating`, `explore.myRatings`, `explore.comments`, `explore.addComment` — `@experimental` |
| `sdk.project` (**draft**) | `project.remix` (as `sdk.project.remix`) — `@experimental`, **not yet served** |

**Served by mythwork#296+:** the `sdk.explore` namespace (14 methods) and the
`sdk.profile.*` additions (4 methods) are `@experimental` but **served by hosts
running mythwork#296 or later** — the host bridges shipped in that PR. The lone
exception is **`sdk.project.remix`**, which still has **no bridge** and is **not
yet served** (calling it against any current host rejects). All of these stay
`@experimental` — present so apps can compile today, and the surface may still
evolve before 1.0. See "Explore surface" in `@mythwork/protocol`'s README for
the full method/type tables.

Note: `project.getName` (singular) exists in `@mythwork/protocol`'s `MethodMap`
but is not exposed as a helper — use `sdk.project.getNames` (the batch variant)
or `sdk.request('project.getName', { pid })` directly.

---

## Error and timeout behavior

- **Wire error:** the host rejects a request by returning `{ id, error: string }`.
  `request()` rejects with `new Error(error)`.
- **Timeout:** if no reply arrives within `opts.timeoutMs` (default `DEFAULT_REQUEST_TIMEOUT_MS` = 30 s), the request rejects with a timeout error
  message. Override per-call: `sdk.fs.read({ pid, path }, { timeoutMs: 5000 })`.
- **Handshake timeout:** `connect({ timeoutMs: 10_000 })` overrides the 5 s
  default handshake budget.
- **`NO_PORT_ERROR`:** exported string constant. `connect()` rejects with this
  message when the app is not running inside a Mythwork host frame.

---

## Host-frame requirement

`connect()` requires a browser `window` global. Calling it in a non-DOM
environment (Node, Deno, edge workers) throws immediately. Inside a browser
window it sends `oc-ping` messages to `window.parent`; a page loaded directly
(not in an iframe) will never receive a reply and the call will reject after the
budget.

```ts
// Explicit error handling
import { connect, NO_PORT_ERROR } from '@mythwork/sdk'

try {
  const sdk = await connect()
  // ... app code
} catch (err) {
  if (err instanceof Error && err.message === NO_PORT_ERROR) {
    // App must be embedded in a Mythwork host frame
  }
  throw err
}
```

---

## Testing

A fake host is a `MessageChannel` that answers `{ id, method, args }` messages
with `{ id, result }` replies. Pass the channel's port to `MythworkClient`
directly (skipping the handshake):

```ts
import { MythworkClient } from '@mythwork/sdk'

// Create a fake host
const { port1, port2 } = new MessageChannel()
port2.addEventListener('message', (e) => {
  const { id, method } = e.data
  if (method === 'kernel.getUser') {
    port2.postMessage({ id, result: { kind: 'anonymous', userId: 'anonymous' } })
  }
})
port2.start()
port1.start()

// Construct client directly (no handshake needed in tests)
const sdk = new MythworkClient(port1)
const user = await sdk.auth.getUser()
// user.kind === 'anonymous'
```

See `sdk/client/src/*.test.ts` for the full test suite.
