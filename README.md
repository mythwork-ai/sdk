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
| [`@mythwork/protocol`](./protocol/) | Wire spec: envelope types, handshake constants, `MethodMap` (all 49 RPC methods), `EventMap` (all 7 push events), and the pure data types they reference (`User`, `CommitInfo`, `DiffEntry`, …). | Constants only (message-type strings, `PROTOCOL_VERSION`). Zero dependencies. |
| [`@mythwork/sdk`](./client/) | Client: port acquisition (handshake), `MythworkClient.request()` typed against `MethodMap`, `MythworkClient.subscribe()` typed against `EventMap`, and thin namespaced helpers (`sdk.fs.read`, `sdk.auth.getUser`, …). | Small; depends only on `@mythwork/protocol`. |

`@mythwork/sdk` re-exports everything from `@mythwork/protocol`, so most callers
only need a single `npm install @mythwork/sdk`.

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

## Design document

Full rationale, wire compatibility notes, and implementation phases:
[`docs/superpowers/specs/2026-06-11-mythwork-sdk-design.md`](../docs/superpowers/specs/2026-06-11-mythwork-sdk-design.md)

## Versions

Current: `0.1.0` (both packages move in lockstep).
