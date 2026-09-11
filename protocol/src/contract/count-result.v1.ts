// THE `count` verb's wire half: the path segment that names the route,
// and the answer it gives. Version-named because it DEFINES a serialized
// wire format, per the versioning policy in projectdb/working-stage.md.
//
// HOW THIS RELATES TO WHAT ALREADY EXISTS. One file per verb: this is
// count's, beside get-row.v1.ts, create-body.v1.ts, update-patch.v1.ts,
// delete-result.v1.ts, and list-query.v1.ts. Count is the verb whose
// REQUEST half is not its own — it takes the same filter the list route
// takes, EntityFilter in contract/list-query.v1.ts, read by the same
// translator, which is why the two can never drift in what they accept.
// What is left over, and lives here, is the word in the path and the
// one-member answer.
//
// ADD-ONLY, from this increment onward (the wire-contract hard rule): a
// member may be ADDED to the answer here; none may be renamed and none may
// change meaning. See contract/wire-contract-v1.md.

/** THE defining place of the `count` path segment. The count route is the
 * one data route whose last path segment is a fixed word rather than a row
 * id, and before this constant existed that word lived only as a quoted
 * literal inside the instance's own path dispatch — which broke both
 * string laws: no inline literal, and wire strings live in the contract
 * plane. The other path segments are matched by regular expressions rather
 * than compared, so they have no equivalent constant. */
export const COUNT_PATH_SEGMENT = 'count'

/** THE count route's answer: one member, a whole number of rows.
 *
 * The number counts only rows the caller may read, so it can never reveal
 * more than paging the list route would, and a caller permitted to see
 * nothing gets a plain zero rather than an error. */
export type CountResult = { count: number }
