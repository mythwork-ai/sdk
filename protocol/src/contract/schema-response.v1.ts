// THE response body of GET /projects/{projectId}/schema — full schema
// retrieval, as the instance answers it today. Version-named because it
// defines a serialized wire format, per the versioning policy in
// projectdb/working-stage.md.
//
// The body is the registry's version number plus the stored record's
// entities CARRIED VERBATIM. `entities` below is typed BY REFERENCE to
// StoredSchema['entities'] rather than restated, so the wire shape cannot
// drift from the record shape: whatever a published record holds per
// entity is exactly what a reader of this body gets.
//
// ============================================================
// IS THIS ENOUGH FOR A DRIVER THAT NEEDS FULL SCHEMA RETRIEVAL?
// Yes, provided the driver also carries a small set of facts statically.
// Both halves below were read off the code, not assumed.
//
// WHAT A DRIVER CAN READ STRAIGHT OUT OF THIS BODY
//   - the registry version the schema is at (0 before any publish has
//     run, then the version the last apply wrote)
//   - every entity's name — the keys of `entities`
//   - every entity's description, carried verbatim from the declaration
//   - every entity's physical id (`entityId`), which names its table
//   - every DECLARED field name on every entity — the keys of an entity's
//     `fields` map
//   - every declared field's physical id (`fieldId`), which names its
//     column
//   - every declared field's FULL published declaration, under `def`: its
//     kind, whether it is required, its description, its size caps
//     (maxLength on a string, maxBytes on a json field), an enum's
//     complete value list, a number's checks (the bounds and the
//     whole-number flag), any declared default including the $now token,
//     and whether the field is unique
//   - every entity's access rules, under `row_level_access`, exactly as
//     published
//
// WHAT THE BODY OMITS, so a driver must know it STATICALLY from
// contract/server-managed.ts
//   - THE FOUR SERVER-MANAGED FIELDS that exist on every entity —
//     SERVER_MANAGED_FIELDS: id, created_at, updated_at, created_by. They
//     appear in no entity file and in no stored record, because
//     provisioning owns them rather than any declaration. They are
//     nonetheless present on every row a read returns, they are
//     filterable and (except created_by, which is a string) sortable, and
//     no client may ever write one.
//   - THE `users` ENTITY'S EXTRA MANAGED FIELD — mythwork_id, from
//     SERVER_MANAGED_ENTITIES.users.extraManagedFields. It exists only on
//     `users`, it is unique, the engine fills it from the verified caller,
//     and it is readable but never writable. It is likewise absent from
//     the record, so a driver reading `users` out of this body sees an
//     entity whose declared field map may be empty while its rows in fact
//     carry five server-owned members.
//   - THE RECORD'S OWN FORMAT VERSION (`v` on StoredSchema). The body
//     carries the REGISTRY version, which counts publishes, and not the
//     record format version, which says which reader speaks the record.
//     No format-version marker rides this body at all; see the "Open,
//     unruled" section of contract/wire-contract-v1.md.
// ============================================================

import type { StoredSchema } from './schema-record.v1'

export type SchemaResponse = {
  /** The schema registry's version: 0 on an instance where no publish has
   * run yet, and afterwards the version the last apply wrote. It counts
   * publishes; it is not a format version. */
  version: number
  /** The stored record's entities, VERBATIM — same keys, same per-entity
   * shape, no projection and no renaming. Typed by reference so the two
   * can never diverge. */
  entities: StoredSchema['entities']
}
