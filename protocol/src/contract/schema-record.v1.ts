// The stored schema record — shared contract module (engine, SDK, and
// generation all import it). REUSES the entity-file types verbatim; the
// engine adds only provisioning facts, as a wrapper — it never restates a
// field's shape. Rule: if a member exists on the entity-file type, the
// engine reads it from `def`; a member may appear on the wrapper only when
// it CANNOT exist in the file (provisioned ids), and its comment must say
// where it comes from.
//
// VERSIONING: this record is a serialized format, so it carries its format
// version twice over — `v` inside every stored record, and the version in
// this FILE's name. When the record shape ever changes incompatibly, a
// schema-record.v2.ts is born beside this file and the engine keeps the v1
// reader for records already in instances; the file name is what makes
// "which shape am I reading" answerable at the import site.

import type { AccessRules, EntityName, FieldDef, FieldName } from './entity.types.v1'

/** A field as stored in the ACTIVE schema record: the published entity-file
 * FieldDef VERBATIM (discriminated union intact — enum values, maxLength,
 * maxBytes, check, unique, default all live on the def, exactly as declared),
 * plus the one fact only the engine knows: */
export type StoredField = {
  fieldId: number // minted once at publish by id provisioning; names the
  // physical column f<fieldId>. NOT in the entity file.
  def: FieldDef // the published field, unmodified.
}

export type StoredEntity = {
  entityId: number // minted at publish; physical table e<entityId>
  description: string // the entity file's description, carried VERBATIM —
  // the published record is where later sessions, the generated client's
  // doc comments, and approval cards read design intention from
  fields: Record<FieldName, StoredField> // keyed by CURRENT name (no aliases)
  row_level_access: AccessRules // the published rules, SAME NAME as the jsonc
}
// What is deliberately NOT stored per entity, so its absence reads as
// designed rather than forgotten: the entity's `name` (it is this record's
// map key, stored once), `last_named` (a rename breadcrumb is CONSUMED at
// publish, never persisted), and the entity file's own `v` (that versions
// the FILE format; this record has its own `v` below). If the entity-file
// type ever grows another durable member, it is carried here the same way
// description is — verbatim, same name.

/** THE ACTIVE SCHEMA RECORD. "Record" means exactly this: the single most
 * recent published schema, stored in the DB it governs. It is NOT a log —
 * prior schemas are not kept here (whole-DO snapshots are the history).
 * Nothing in the engine may read, keep, or depend on an older record. */
export type StoredSchema = {
  v: 1 // the version of THIS RECORD FORMAT — every serialized DSL in the
  // system carries its format version, and the stored record is the most
  // durable serialized thing there is: it outlives deploys, so a future
  // engine must be able to tell which reader a stored record needs.
  entities: Record<EntityName, StoredEntity>
}
