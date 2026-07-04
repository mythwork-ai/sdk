# Mythwork SDK

The **Mythwork inner-app SDK** is the public postMessage API for apps hosted on
the Mythwork platform. An inner app (running inside a host-frame `<iframe>`) uses
this SDK to read and write project files, commit to git, manage authentication,
join collaborative rooms, and more — all by exchanging messages with the
surrounding host frame over a transferred `MessagePort`.

## Packages

The SDK is two lockstep-versioned packages that publish together:

| Package | Role | Runtime code |
|---|---|---|
| [`@mythwork/protocol`](./protocol/) | Wire spec: envelope types, handshake constants, `MethodMap` (every RPC method), `EventMap` (every push event), and the pure data types they reference (`User`, `CommitInfo`, `DiffEntry`, …). | Constants only (message-type strings, `PROTOCOL_VERSION`). Zero dependencies. |
| [`@mythwork/sdk`](./client/) | Client: port acquisition (handshake), `MythworkClient.request()` typed against `MethodMap`, `MythworkClient.subscribe()` typed against `EventMap`, and thin namespaced helpers (`sdk.fs.read`, `sdk.auth.getUser`, …). | Small; depends only on `@mythwork/protocol`. |

`@mythwork/sdk` re-exports everything from `@mythwork/protocol`, so most callers
only need a single `npm install @mythwork/sdk`.

## Higher-level packages built on this SDK

The SDK itself stays a thin, opinion-free wire client (see below). Apps that
want more than raw RPC — streaming edits, hosted agent sessions — use a
separate package built on top of `@mythwork/sdk`, versioned and published
independently:

| Package | Layer | Role |
|---|---|---|
| [`@mythwork/agent`](../packages/agent/) | 3 | Hosted agent sessions: `AgentSession` + `useAgent()` over the `agent.*` RPC surface (`sdk.agent.*`). Consumers supply UI, voice, and rendering; the platform owns the loop, tools, and prompts. |

These packages are **not** part of the `sdk/` tree and are not covered by its
self-containment or public-mirror guarantees below — they're regular
monorepo packages that happen to depend on `@mythwork/sdk`.

## Self-contained by design

`sdk/` imports nothing from the rest of the monorepo (`packages/`, `shared/`,
`workers/`). The tree is structured so that copying `sdk/` out verbatim is the
mirror step for publishing to a separate clean repo. Wire names (e.g.
`kernel.getUser`, `db.get`) are preserved exactly as deployed; the client maps
these to clean namespaces so consuming code never sees the legacy strings.

## Public mirror

This tree is mirrored read-only to
[`mythwork-ai/sdk`](https://github.com/mythwork-ai/sdk) by the
`sync-sdk-mirror` workflow — automatically after every npm release, or on
manual dispatch. The monorepo is the single source of truth (the conformance
suites pinning this contract to the live bridge implementations run here);
development, issues, and PRs happen in `mythwork-ai/mythwork`, never against
the mirror.

## v1 source-shipped TypeScript policy

Both packages ship **raw TypeScript source** at v1. The `exports` map in each
`package.json` points directly at `src/*.ts`, and consumers' own bundlers (Vite,
esbuild, tsc) compile the source. No pre-built `dist/` directory is included.
This keeps the packages small and avoids a separate build step in the publishing
repo.

## Per-project encrypted env store (`sdk.env`)

`sdk.env` exposes two methods. Values are stored AES-256-GCM encrypted in a
`/.env` file committed to the project's git tree; the platform-derived KEK is
held only by the host frame and never exposed to app code.

| Method | Result | Notes |
|---|---|---|
| `sdk.env.list()` | `{ names: string[] }` | Names only — values are never returned to app code. Local-only or unauthenticated project resolves `{ names: [] }`. |
| `sdk.env.open()` | `{ ok: boolean }` | Opens the host-owned editor popup. Resolves `{ ok: true }` on save, `{ ok: false }` on cancel, or if the project is local-only or unsigned-in. |

**No `env.get()` in v1** — app-readable runtime secret values need separate threat
modeling; deferred to future work. The runtime consumer today is the host-side
agent bridge.

**`PROMPT_<NAME>` namespace:** entries named `PROMPT_<PERSONA>` (e.g.
`PROMPT_GAIAD_VOICE` for persona `gaiad_voice`) back agent persona presets.
The agent bridge resolves persona text from the env store before falling back to
the legacy `project_prompts` path. See
[`docs/2026-07-03-project-env-store.md`](../docs/2026-07-03-project-env-store.md)
for the full key-derivation, threat model, and resolution-order details.

## Design document

Full rationale, wire compatibility notes, and implementation phases:
[`docs/superpowers/specs/2026-06-11-mythwork-sdk-design.md`](../docs/superpowers/specs/2026-06-11-mythwork-sdk-design.md)
