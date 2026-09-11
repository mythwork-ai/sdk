// THE `update` verb's request body — the partial patch a PATCH carries.
// Version-named because it DEFINES a serialized wire format, per the
// versioning policy in projectdb/working-stage.md.
//
// HOW THIS RELATES TO WHAT ALREADY EXISTS. One file per verb: this is
// update's, beside get-row.v1.ts, create-body.v1.ts, delete-result.v1.ts,
// count-result.v1.ts, and list-query.v1.ts. The patch below is the only
// shape update adds to the wire.
//
// WHAT THIS FILE DELIBERATELY DOES NOT RESTATE. Update's ANSWER is the
// whole stored row, the same shape and the same bytes a get answers with
// — written down once, in contract/get-row.v1.ts. The keys no write body
// may carry are derived from the server-managed field registry, in
// contract/server-managed.ts, and shared with the create body. A patch
// aimed at a row the caller cannot reach answers TARGET_MISSING, whose
// details shape lives with the code in contract/wire-errors.v1.ts.
//
// ADD-ONLY, from this increment onward (the wire-contract hard rule): a
// member may be ADDED to the body here; none may be renamed and none may
// change meaning. See contract/wire-contract-v1.md.

import type { SchemaRow } from './db-client.interface'
import type { NoServerManagedKeys } from './server-managed'

/** THE update body: a PARTIAL patch, and the only place on this wire where
 * null is a legal value.
 *
 * Every member is optional — an omitted field is left untouched — and
 * every member additionally admits null, which CLEARS an optional field.
 * The relation to CreateBody (contract/create-body.v1.ts) is neither
 * subset nor superset: its keys are the same declared set, its members are
 * all optional where a create's required ones are not, and its values
 * admit a null a create's never do.
 *
 * The null-admitting half is why this type is a mapped type rather than
 * Partial<TDeclared>. It is also the one asymmetry with the FILTER
 * grammar, where null is deliberately absent (FilterScalar in
 * contract/list-query.v1.ts): a patch can clear a value, and no query can
 * ask for one.
 *
 * WHAT THE TYPE CANNOT SAY, so it is written here instead:
 *   - null on a REQUIRED field is REQUIRED_MISSING. A required field can
 *     be changed to another valid value but never emptied.
 *   - a present value REPLACES the stored one whole, json values included.
 *     There is no merge of any kind.
 *   - a server-managed name is PROHIBITED_FIELD, exactly as in a create.
 *   - an EMPTY patch is accepted and moves updated_at with no field
 *     changing — flagged as unruled in the update section of
 *     contract/wire-contract-v1.md. */
export type PatchBody<TDeclared = SchemaRow> = {
  [K in keyof TDeclared]?: TDeclared[K] | null
} & NoServerManagedKeys
