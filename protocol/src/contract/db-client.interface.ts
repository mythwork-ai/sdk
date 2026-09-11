// The client-crossing shapes of the verb surface: the branded wire
// scalars, the row as apps see it, and the list call's argument and page
// shapes. The engine and the generated client both refer to THESE
// definitions — nothing wire-shaped is declared engine-side.

export type Id<E extends string> = number & { readonly __entity: E }
// Engine-provisioned INTEGER PRIMARY KEY AUTOINCREMENT: part of
// provisioning, never client- or agent-owned, immutable per row.

export type IsoUtc = string & { readonly __isoUtc: true }
// Datetimes are ALWAYS UTC: ISO-8601 UTC strings on the wire and in the
// client; stored as UTC epoch ms in SQLite; no marshalling layer exists.

export type PageToken = string & { readonly __pageToken: true }
// Keyset bookmark: "the last row I showed you", sealed in an opaque
// engine-minted token. Only ever obtained from a previous page's `next`.

export type SchemaRow = Record<string, unknown>
// A row as the active schema defines it: current field names, dates as
// IsoUtc strings, json as parsed values — what apps send and receive.
// Untyped here because this plane is project-agnostic; per-entity TYPED
// rows exist only in the generated client, which narrows this shape.

export type ListArgs = {
  where?: unknown // the JSON-parsed where param — the filter object
  sort?: unknown // the raw sort string ('-due_at', '+title', 'title')
  starting_after?: unknown // a previous page's next value, verbatim
  limit?: unknown // Number()-parsed by the transport
}
// All four are unknown ON PURPOSE: these arrive from the wire, and the
// engine's translators are where they get validated — loudly.

export type PageResult = { rows: SchemaRow[]; next: string | null }
// next is a sealed page token (PageToken in the generated client's
// narrowed view); null means the walk is done.
