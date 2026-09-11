// THE `get` verb's wire half: the row a read answers with, and the id a
// read path carries. Version-named because it DEFINES a serialized wire
// format, per the versioning policy in projectdb/working-stage.md.
//
// HOW THIS RELATES TO WHAT ALREADY EXISTS. One file per verb: this is
// get's, beside create-body.v1.ts, update-patch.v1.ts,
// delete-result.v1.ts, count-result.v1.ts, and list-query.v1.ts. The row
// shape and the id type are DEFINED once, in
// contract/db-client.interface.ts, and this file re-exports them rather
// than restating them — a second row shape is exactly the drift the
// contract plane exists to prevent. The re-export lives HERE and in no
// other verb file: get is the verb whose whole answer is the row, so the
// prose about that row has one home, and create and update point at it.
//
// WHAT THIS FILE DELIBERATELY DOES NOT RESTATE. The read miss — three
// situations folded into one TARGET_MISSING answer — is described with
// the code itself, in contract/wire-errors.v1.ts, because update and
// delete answer it too.
//
// ADD-ONLY, from this increment onward (the wire-contract hard rule): a
// member may be ADDED to a body here; none may be renamed and none may
// change meaning. See contract/wire-contract-v1.md.

import type { Id, SchemaRow } from './db-client.interface'
import type { ServerManagedRow } from './server-managed'

/** The body get, create and update all answer: one whole row, in the form
 * the active schema defines. Defined once, in
 * contract/db-client.interface.ts — re-exported here, and NOT redefined.
 *
 * THE SAME BYTES FROM ALL THREE. A create's 201 body and an update's 200
 * body are produced by the same serialization every read uses, so the row
 * a write answers with is byte-identical to what a later get returns. A
 * client never needs to follow a write with a read.
 *
 * NO PROJECTION EXISTS. Get takes no field list, and neither does list:
 * a row is always answered whole. A field whose column is NULL is OMITTED
 * from the object entirely rather than sent as null.
 *
 * ServerManagedRow<E> is the half of that row the server owns — id, the
 * two timestamps, and created_by, which is absent on a row an anonymous
 * caller created. It is re-exported beside the row so a driver author
 * reading these bodies finds the members no schema response mentions. */
export type { SchemaRow, ServerManagedRow }

/** The row id a path carries. Engine-assigned, an integer of 1 or more,
 * never client-chosen and never reused after a delete. Defined once, in
 * contract/db-client.interface.ts, and re-exported rather than restated.
 *
 * AN ID THAT IS NOT ONE OF THOSE IS NOT AN ERROR. A path segment that is
 * not a positive integer is folded into the same answer a missing row
 * gives — see TargetMissingDetails in contract/wire-errors.v1.ts. */
export type { Id }
