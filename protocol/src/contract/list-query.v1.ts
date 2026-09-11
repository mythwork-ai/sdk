// THE ONE list/query wire shape — the four query-string parameters a
// client sends to the list and count routes, and the grammar of each.
// Version-named because it DEFINES a serialized wire format, per the
// versioning policy in projectdb/working-stage.md.
//
// HOW THIS RELATES TO ListArgs (contract/db-client.interface.ts). They are
// the SAME FOUR MEMBERS, at two different moments:
//
//   - ListQuery (this file) is what a WELL-FORMED CLIENT SENDS. Every
//     member carries the type the engine will accept, so a client that
//     type-checks against it has already avoided every shape error the
//     engine would raise.
//   - ListArgs is those same four members AFTER TRANSPORT PARSING, with
//     all four typed `unknown` on purpose: they arrive off the wire
//     unvalidated, and the engine's translators are where they get
//     judged — loudly. Nothing may narrow them earlier.
//
// The two definitions therefore carry the same key set and must never
// drift. The compile-time check at the bottom of this file is what
// enforces that.
//
// ADD-ONLY, from this increment onward (the wire-contract hard rule): a
// parameter name, an operator, or a member may be ADDED here; none may be
// renamed and none may change meaning. See contract/wire-contract-v1.md.

import { config } from './config'
import type { IsoUtc, ListArgs, PageResult, PageToken } from './db-client.interface'
import type { ConditionOperator, OPERATORS, SORT_PREFIXES } from './tokens.v1'

/** THE defining place of the four query-string parameter NAMES. Keyed by
 * the member name the engine knows, valued by the exact string that
 * appears in the URL. Before this constant existed these four strings
 * lived only as quoted literals inside the transport, which broke both
 * string laws — no inline literal, and wire strings live in the contract
 * plane. */
export const LIST_QUERY_PARAMS = {
  // ALL FOUR WIRE NAMES MATCH THE MEMBER NAMES THEY CARRY. There is no
  // divergence anywhere in this table: the name the engine knows a
  // parameter by is the name that appears in the URL.
  //
  // The FILTER parameter. Its value is a JSON-encoded EntityFilter. The
  // design document that this surface came from spelled it `q`; it was
  // aligned to `where` — the member name used in the client interface, in
  // the engine's argument type, and in the filter translator — before the
  // contract froze, which was the last moment the add-only rule allowed a
  // rename.
  where: 'where',
  sort: 'sort',
  starting_after: 'starting_after',
  limit: 'limit',
} as const
export type ListQueryParamName = (typeof LIST_QUERY_PARAMS)[keyof typeof LIST_QUERY_PARAMS]

// ---- the filter grammar ----

/** Every value a filter may carry. `null` is DELIBERATELY ABSENT: the
 * engine's single validation pass type-checks a filter value against the
 * field's declared kind before anything else, and `null` fails that check
 * on every kind — so there is no way to query for an absent value on the
 * wire today. A future null operator would be an ADD, which the hard rule
 * permits. */
export type FilterScalar = string | number | boolean | IsoUtc

/** The one operator whose value is a LIST. Non-empty, and at most
 * config.inListMax entries (inListMax, currently: 100). Admits every
 * scalar field kind. */
export type FilterListOperator = typeof OPERATORS.in

/** The operators whose value is a single ORDERED scalar. Admitted only on
 * the two field kinds that have a defined ordering — number and datetime —
 * which is why the value type is `number | IsoUtc` rather than any
 * scalar. Derived from the operator registry so this set can never fall
 * behind it. */
export type FilterRangeOperator = Exclude<ConditionOperator, FilterListOperator>

/** The value type each range operator takes: a number for a number field,
 * an ISO-8601 UTC instant for a datetime field. */
export type FilterOrderedValue = number | IsoUtc

/** An operator object: one entry per operator being applied to this
 * field. SEVERAL operators on one field AND together (a lower and an
 * upper bound is how a range is written). There is no or-combinator on
 * this surface at all.
 *
 * WHAT THE TYPE CANNOT SAY, so it is written here instead: an operator
 * object must carry at least one entry — an empty object contributes no
 * condition and is not a legal filter entry. */
export type FilterOperatorObject = {
  [K in FilterListOperator]?: [FilterScalar, ...FilterScalar[]]
} & {
  [K in FilterRangeOperator]?: FilterOrderedValue
}

/** One field's condition: a bare scalar for exact equality, or an
 * operator object. */
export type FieldCondition = FilterScalar | FilterOperatorObject

/** THE filter. Keyed by SCALAR field name — a declared field of any kind
 * except json, or one of the server-managed fields. json fields are never
 * filterable. Entries AND together, and the total number of conditions the
 * filter produces is capped by config.filterMaxConditions
 * (filterMaxConditions, currently: 32). */
export type EntityFilter = Record<string, FieldCondition>

// ---- the sort parameter ----

/** The prefix characters a sort string may open with, from the one place
 * they are defined. */
export type SortPrefix = (typeof SORT_PREFIXES)[keyof typeof SORT_PREFIXES]

/** The sort parameter: exactly ONE field name, optionally prefixed.
 *
 * THE GRAMMAR, in words, because a TypeScript type cannot express "a
 * minus sign followed by a field name that exists on this entity":
 *
 *   -<field>   descending
 *   +<field>   ascending
 *   <field>    ascending (a bare name is the same as the '+' form)
 *
 * The prefix characters themselves are SORT_PREFIXES.descending and
 * SORT_PREFIXES.ascending. Omitting the parameter entirely means newest
 * first, which is the id column descending. json fields are never
 * sortable, and neither is the server-managed created_by field — it is a
 * string, and only the ordered managed fields (id and the two timestamps)
 * may be sorted by. */
export type SortParam = `${SortPrefix}${string}` | string

// ---- paging ----

/** The whole query a well-formed client sends. Every member is optional;
 * a request carrying none of them is a legal first page. */
export type ListQuery = {
  /** The filter, JSON-encoded into the `where` parameter on the wire. */
  where?: EntityFilter
  /** One sortable field, optionally prefixed. See SortParam. */
  sort?: SortParam
  /** A resume point, ONLY ever the `next` value of a previous page,
   * carried back verbatim. It is opaque, it is bound to the sort it was
   * minted under, and a client never constructs one. */
  starting_after?: PageToken
  /** How many rows this page may hold: a whole number from 1 to
   * config.pageLimitMax (pageLimitMax, currently: 200). Absent means
   * config.pageLimitDefault (pageLimitDefault, currently: 50). An
   * out-of-range value is a loud error, never a silent clamp. */
  limit?: number
}

/** The response body of the list route. PageResult is defined once, in
 * contract/db-client.interface.ts — re-exported here so a driver author
 * reading the query shape finds the answer shape beside it, and NOT
 * redefined, because a second page shape is exactly the drift this file
 * exists to prevent. */
export type { PageResult }

/** The two paging caps, referenced rather than restated: the config file's
 * own rule is that no other file states one of its numbers, so a call site
 * that needs the bound reads it from here. */
export const LIST_LIMIT_BOUNDS = {
  min: 1,
  max: config.pageLimitMax,
  default: config.pageLimitDefault,
} as const

// ---- the anti-drift check ----

/** True only when the two types carry EXACTLY the same key set. The
 * tuple wrapping stops the conditional from distributing over the key
 * unions, so this is one union-to-union assignability test in each
 * direction. */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false

// THE TRIPWIRE. ListQuery and ListArgs describe the same four members at
// two moments (see this file's header). If either grows, loses, or renames
// a member without the other following, SameKeys resolves to `false` and
// this assignment stops compiling.
const _listQueryKeysMatchListArgs: SameKeys<ListQuery, ListArgs> = true
void _listQueryKeysMatchListArgs
