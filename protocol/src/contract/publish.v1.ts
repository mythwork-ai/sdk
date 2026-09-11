// The publish wire — the declaration documents a harness PUTs at the
// schema resource, and the shapes the instance answers with. Contract-plane
// because every one of these crosses the wire: the harness builds the
// documents, the platform UI renders the violation list and the approval
// cards, and the retry carries approval ids back.
//
// THE DECLARATION DOCUMENT IS JSON, NEVER FILE TEXT. Whichever harness is
// current (entity files today, a generation pipeline tomorrow) parses its
// own authoring format into this document; the instance validates and
// consumes only this. When the harness changes, this contract does not.
// Like every serialized DSL in the project, it carries its own format
// version.

import type { AccessRules, EntityName, FieldDef, FieldName } from './entity.types.v1'
import type { SchemaOperation } from './publish-ops.v1'

export const DECLARED_SCHEMA_V = 1 as const

/** One entity as a harness declares it. The entity's NAME is the map key
 * (full document) or the URL path segment (single-entity document) — never
 * repeated inside. No ids anywhere: identity across renames is claimed by
 * the breadcrumbs, and ids are minted server-side at apply. */
export type DeclaredEntity = {
  description: string
  last_named?: EntityName // entity rename breadcrumb (see entity.types.v1)
  // Each field is a full FieldDef — which already carries its own
  // description and last_named breadcrumb, exactly as authored.
  fields: Record<FieldName, FieldDef>
  row_level_access?: AccessRules // ABSENT on users — its rules are fixed
  // by the server and a users declaration carrying any is a violation
}

/** PUT /projects/{pid}/schema — the whole schema, the promotion act.
 * PUT semantics are literal: this document REPLACES the schema resource,
 * so a published entity or field absent from it is a DELETE (and raises
 * an approval card). `approvals` carries the ids of cards the owner
 * answered; the retry after PENDING_APPROVAL is this same PUT with them. */
export type DeclaredSchemaDoc = {
  v: typeof DECLARED_SCHEMA_V
  entities: Record<EntityName, DeclaredEntity>
  approvals?: string[]
}

/** PUT /projects/{pid}/schema/entities/{name} — one entity, additive only.
 * Declares intent about exactly the named entity: new entity, or new
 * fields on an existing one. Nothing here can rename, retype, narrow,
 * widen access, or delete — such a change answers NOT_ADDITIVE and points
 * at the full publish. Absence of other entities means nothing. */
export type DeclaredEntityDoc = {
  v: typeof DECLARED_SCHEMA_V
  entity: DeclaredEntity
}

// ---- what a blocked publish answers ----

/** The violation kinds, one defining place. These are DETAILS inside the
 * one wire code PUBLISH_BLOCKED — a blocked publish lists every violation
 * it found, each teaching its own repair. */
export const VIOLATION_KINDS = {
  MALFORMED_DECLARATION: 'MALFORMED_DECLARATION', // the document itself
  ILLEGAL_NAME: 'ILLEGAL_NAME', // grammar, or a server-managed name
  ILLEGAL_FIELD_DEF: 'ILLEGAL_FIELD_DEF', // kind/default/check/cap legality
  ILLEGAL_ACCESS_RULE: 'ILLEGAL_ACCESS_RULE', // vocabulary, sentinel/verb,
  // comparison agreement, list cap, lookup legality
  TOO_MANY_FIELDS: 'TOO_MANY_FIELDS', // past the derived per-entity cap
  USERS_FIXED: 'USERS_FIXED', // users declaring access rules, a managed
  // name, a rename, or deleting/changing a published users field
  BREADCRUMB_ABUSE: 'BREADCRUMB_ABUSE', // claims a name nothing published
  // holds, two claimants of one name, or a rename that also re-types
  REQUIRED_NEEDS_DEFAULT: 'REQUIRED_NEEDS_DEFAULT', // required added on a
  // published field without the default the backfill needs
  NOT_ADDITIVE: 'NOT_ADDITIVE', // an incremental publish carrying anything
  // other than creates
  BASELINE_NUMBER_TAKEN: 'BASELINE_NUMBER_TAKEN', // a name this publish
  // creates would adopt a number from the prod record that something
  // else in this record already holds — see the note in
  // engine/publish/apply-publish.v1.ts, where the only site that can
  // reach this conclusion lives
} as const
export type ViolationKind = (typeof VIOLATION_KINDS)[keyof typeof VIOLATION_KINDS]

export type PublishViolation = {
  kind: ViolationKind
  entity?: EntityName
  field?: FieldName
  hint: string // >= 20 words, teaches the repair — same law as every error
}

// ---- what a publish pending approval answers ----

/** One card, shown to the owner by the platform UI at the moment a publish
 * blocks on it. The id binds the answer to THIS exact operation: same file
 * state, same id — a schema that moved after the owner answered no longer
 * matches, and the answer no longer applies. rowCount is information for
 * the human, never part of the id. */
export type ApprovalCard = {
  approvalId: string
  op: SchemaOperation
  rowCount?: number // rows in the affected entity at card time
}

/** The success body of both PUTs. */
export type PublishResult = {
  version: number
  applied: { entities: number; fields: number }
}
