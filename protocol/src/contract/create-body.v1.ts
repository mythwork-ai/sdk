// THE `create` verb's request body. Version-named because it DEFINES a
// serialized wire format, per the versioning policy in
// projectdb/working-stage.md.
//
// HOW THIS RELATES TO WHAT ALREADY EXISTS. One file per verb: this is
// create's, beside get-row.v1.ts, update-patch.v1.ts,
// delete-result.v1.ts, count-result.v1.ts, and list-query.v1.ts. The body
// below is the only shape create adds to the wire.
//
// WHAT THIS FILE DELIBERATELY DOES NOT RESTATE. Create's ANSWER is the
// whole stored row, the same shape and the same bytes a get answers with
// — written down once, in contract/get-row.v1.ts. The keys no write body
// may carry are derived from the server-managed field registry, in
// contract/server-managed.ts, and shared with the update patch.
//
// ADD-ONLY, from this increment onward (the wire-contract hard rule): a
// member may be ADDED to the body here; none may be renamed and none may
// change meaning. See contract/wire-contract-v1.md.

import type { SchemaRow } from './db-client.interface'
import type { NoServerManagedKeys } from './server-managed'

/** THE create body: a single JSON object of DECLARED field values.
 *
 * Generic in the declared half of a row so the generated client can pass
 * its own per-entity type and get a checked body; the default parameter is
 * SchemaRow, which is this plane's project-agnostic row shape. The
 * relation to SchemaRow is therefore SUBSET: every legal create body is a
 * SchemaRow whose keys are all declared ones.
 *
 * WHAT IS AND IS NOT LEGAL IN IT:
 *   - a declared field this entity does not have is UNKNOWN_FIELD
 *   - a server-managed name is PROHIBITED_FIELD — deliberately a different
 *     code from UNKNOWN_FIELD, because the field exists and simply is not
 *     the client's to set (NoServerManagedKeys in
 *     contract/server-managed.ts makes the same mistake a compile error)
 *   - a required field with no declared default must be present, or the
 *     answer is REQUIRED_MISSING
 *   - an optional field may simply be absent, and its column stays empty
 *   - the body may be EMPTY, and on an entity whose fields are all
 *     optional an empty body is a legal create — see the create section of
 *     contract/wire-contract-v1.md, which flags that as unruled
 *
 * NOTHING IS AUTO-STAMPED INTO IT. When an entity's create rule compares a
 * DECLARED field against the caller's id, the client sends that field
 * itself; omitting it is a loud SCOPE_DENIED whose message teaches the
 * repair, not a silent fill. */
export type CreateBody<TDeclared = SchemaRow> = TDeclared & NoServerManagedKeys
