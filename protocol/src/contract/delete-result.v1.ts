// THE `delete` verb's answer. Version-named because it DEFINES a
// serialized wire format, per the versioning policy in
// projectdb/working-stage.md.
//
// HOW THIS RELATES TO WHAT ALREADY EXISTS. One file per verb: this is
// delete's, beside get-row.v1.ts, create-body.v1.ts, update-patch.v1.ts,
// count-result.v1.ts, and list-query.v1.ts. Delete is the one verb with
// neither a request body nor a response body, so this file is the shortest
// of the six — it exists so a reader walking the verbs finds delete where
// the other five are, rather than inferring its absence.
//
// WHAT THIS FILE DELIBERATELY DOES NOT RESTATE. The id in the path is the
// same Id every row-addressed verb carries, re-exported once in
// contract/get-row.v1.ts. A delete aimed at a row the caller cannot reach
// answers TARGET_MISSING, whose details shape lives with the code in
// contract/wire-errors.v1.ts.
//
// ADD-ONLY, from this increment onward (the wire-contract hard rule): a
// member may be ADDED; none may be renamed and none may change meaning.
// See contract/wire-contract-v1.md.

/** THE delete route's answer: 204 and no body at all. Written as a type so
 * a reader of the verb files meets all six, and as `null` rather than
 * `void` because that is what a client reading the response actually has:
 * an empty payload, not an absent one.
 *
 * The delete is HARD. There is no soft-delete flag, no tombstone, and no
 * undo verb, so a client that needs recoverable removal models it as a
 * field of its own. Deleting the same id twice answers TARGET_MISSING the
 * second time — a write is never a silent no-op. */
export type DeleteResult = null
