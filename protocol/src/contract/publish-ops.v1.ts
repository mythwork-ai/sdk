// The schema-operation DSL: the operation shapes a publish plan is made
// of, and nothing else — pure types plus one type guard.
//
// THE MODEL: evaluating a declaration against the stored schema produces a
// SchemaOperation for EVERY entity change and EVERY field change, at those
// two grains, kind create|update|delete. Operations carry WHOLE from/to
// shapes, never deltas, so approval classification and the apply both read
// one operation and need nothing else. Approval-worthiness is a pure
// predicate computed over an operation after the fact — never baked into
// the operation itself — and the apply executes the list uniformly.
//
// IDS: create operations carry names only — entity and field ids are
// minted server-side at apply (there is no lockfile; files carry no ids).
// Update and delete operations always concern something already published,
// so they carry the stored ids.
//
// Contract-plane because approval cards carry operations verbatim to the
// platform UI. `v` versions THIS format, per the DSL-versioning rule.
// The approval BINDING (hashing an operation into its approval id) is
// engine behavior and lives with the approval stage.

import type { AccessRules, EntityName, FieldDef, FieldName } from './entity.types.v1'

export const OPS_DSL_V = 1 as const

/** The whole shape of an entity being left or entered — everything but its
 * fields, which have their own operations at the field grain. */
export type EntityShape = {
  name: EntityName
  description: string
  row_level_access: AccessRules
}
export type FieldShape = {
  name: FieldName
  def: FieldDef
}

export type EntityOperation = { v: typeof OPS_DSL_V; grain: 'entity' } & (
  | { kind: 'create'; to: EntityShape }
  | { kind: 'update'; entityId: number; from: EntityShape; to: EntityShape }
  | { kind: 'delete'; entityId: number; from: EntityShape }
)

export type FieldOperation = {
  v: typeof OPS_DSL_V
  grain: 'field'
  // The owning entity by CURRENT declared name — how the apply routes a
  // field of an entity created in this same publish, whose id does not
  // exist yet. entityId is present whenever the entity is already
  // published.
  entityName: EntityName
  entityId: number | null
} & (
  | { kind: 'create'; to: FieldShape }
  | { kind: 'update'; fieldId: number; from: FieldShape; to: FieldShape }
  | { kind: 'delete'; fieldId: number; from: FieldShape }
)

export type SchemaOperation = EntityOperation | FieldOperation
export const isFieldOp = (op: SchemaOperation): op is FieldOperation => op.grain === 'field'

/** The plan both publish verbs produce: every operation the declaration
 * implies, the free ones included, plus any violations only the diff can
 * see (two breadcrumb claimants, a rename that re-types, users tampering
 * visible only against the stored record). */
export type PublishPlan = {
  ops: SchemaOperation[]
}
