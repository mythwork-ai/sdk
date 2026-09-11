// THE single defining file for the $ vocabulary — the NAMES, which field
// kinds each operator fits, and the caps. Pure vocabulary facts, safe to
// ship anywhere: this file is contract-plane and will reach the generated
// client, so it contains NO SQL and NO engine values. How an operator
// becomes SQL is an engine secret (engine/sql.conditions.v1.ts); how a
// default resolves is the validation pass's business. Adding an operator
// is one entry here (the fact) plus one entry in the engine's condition
// mapper (the SQL).

import { FIELD_KINDS, NOW_DEFAULT, type FieldKind } from './entity.types.v1'
import { config } from './config'

// The operator and check names, as keyed constants — the registries below
// derive their keys from these, so the canonical $ strings have one
// defining place and use sites reference them by name.
export const OPERATORS = {
  in: '$in',
  gte: '$gte',
  gt: '$gt',
  lte: '$lte',
  lt: '$lt',
} as const

export const CHECKS = {
  gte: '$gte',
  gt: '$gt',
  lte: '$lte',
  lt: '$lt',
  integer: '$integer',
} as const

// Which field kinds admit ordering, and which admit any condition at all.
const ORDERED = (kind: FieldKind) => kind === FIELD_KINDS.number || kind === FIELD_KINDS.datetime
const ANY_SCALAR = (kind: FieldKind) => kind !== FIELD_KINDS.json // json is never queryable

/** The condition operators: name → the facts about it. DELIBERATELY
 * NARROWER than comparable products (no $ne, no combinators) — the set is
 * expected to WIDEN as real apps justify it. */
export const CONDITION_OPERATORS = {
  [OPERATORS.in]: { admits: ANY_SCALAR, maxValues: () => config.inListMax },
  [OPERATORS.gte]: { admits: ORDERED },
  [OPERATORS.gt]: { admits: ORDERED },
  [OPERATORS.lte]: { admits: ORDERED },
  [OPERATORS.lt]: { admits: ORDERED },
} as const
export type ConditionOperator = keyof typeof CONDITION_OPERATORS

/** The default tokens: name → which kinds may declare it. Resolution
 * (what value a token produces at write time) is the validation pass's
 * business, engine-side. */
export const DEFAULT_TOKENS = {
  [NOW_DEFAULT]: { admits: (kind: FieldKind) => kind === FIELD_KINDS.datetime },
} as const
export type DefaultToken = keyof typeof DEFAULT_TOKENS

/** The numeric check keys: name → its evaluation over a value. Pure
 * predicates, safe anywhere; a client may pre-validate with them. */
export const CHECK_KEYS = {
  [CHECKS.gte]: { evaluate: (v: number, bound: number) => v >= bound },
  [CHECKS.gt]: { evaluate: (v: number, bound: number) => v > bound },
  [CHECKS.lte]: { evaluate: (v: number, bound: number) => v <= bound },
  [CHECKS.lt]: { evaluate: (v: number, bound: number) => v < bound },
  // $integer follows the codebase's flag convention (required, unique):
  // false means the same as absent — a no-op, never a constraint.
  [CHECKS.integer]: { evaluate: (v: number, bound: boolean) => !bound || Number.isInteger(v) },
} as const
export type CheckKey = keyof typeof CHECK_KEYS

/** The sort string's prefix characters — client wire vocabulary: '-' for
 * descending, '+' (or no prefix) for ascending. The sort translator and
 * the generated client both refer to these. */
export const SORT_PREFIXES = {
  descending: '-',
  ascending: '+',
} as const
