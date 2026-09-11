// The single source for what the SERVER owns, at both grains: the FIELDS
// that exist on every entity, and the ENTITIES that exist in every project.
// SHAPE ONLY — names, wire kinds, reserved identities, and the predicates
// over them. Everything the engine DOES with these facts (DDL, stamping,
// write rejection, capacity math) lives in the engine plane; this file is
// what the builder side and the generated client may know.
//
// Server-managed FIELDS appear in no entity file — the entity file is the
// agent's plane, and these fields are provisioning's. Adding a managed
// field is one entry here plus its engine-side behavior entries, which are
// bound to these names by satisfies checks and cannot drift.
//
// Server-managed ENTITIES are the other half: tables the engine creates in
// every project database whether or not the project asks for them, because
// the system itself depends on them. Today there is exactly one, `users`.

import type { Id, IsoUtc } from './db-client.interface'
import type { StoredEntity } from './schema-record.v1'

// The registry-internal wire-kind labels, one defining place.
export const WIRE_KINDS = {
  number: 'number',
  IsoUtc: 'IsoUtc',
  string: 'string',
} as const

export const SERVER_MANAGED_FIELDS = {
  // Physical columns use their LITERAL names, not f<fieldId>: these fields
  // are never in a file and never renameable, so the rename machinery
  // (id-named columns) does not apply to them.
  id: { wire: WIRE_KINDS.number },
  created_at: { wire: WIRE_KINDS.IsoUtc },
  updated_at: { wire: WIRE_KINDS.IsoUtc },
  created_by: { wire: WIRE_KINDS.string },
} as const
export type ServerManagedFieldName = keyof typeof SERVER_MANAGED_FIELDS

// The managed field NAMES as referenceable constants — bound to the
// registry's keys by the satisfies check, so they cannot drift from it.
export const MANAGED_FIELD_NAMES = {
  id: 'id',
  created_at: 'created_at',
  updated_at: 'updated_at',
  created_by: 'created_by',
} as const satisfies { [K in ServerManagedFieldName]: K }

/** THE one predicate for "is this the users entity" — everything that
 * special-cases users (the field lookup, the lookup-rule refusal, the
 * write rejection, the bootstrap) asks here, keyed on the reserved
 * entity id. */
export function isUsersEntity(entity: StoredEntity): boolean {
  return entity.entityId === SERVER_MANAGED_ENTITIES.users.reservedEntityId
}

export function isServerManagedFieldName(name: string): name is ServerManagedFieldName {
  // `hasOwn`, not `in`: `name` is client-controlled at the filter/sort/write
  // surface, and `in` would answer true for prototype-chain names like
  // 'hasOwnProperty'.
  return Object.hasOwn(SERVER_MANAGED_FIELDS, name)
}

/** The server-managed half of every row — generic in the entity name so
 * `id` keeps its brand. The generated client composes Row =
 * ServerManagedRow<E> & TDeclared and the create shape = TDeclared alone.
 * Nothing is retyped by hand. created_by is optional because anonymous
 * callers leave it NULL, and null-valued fields are omitted on reads. */
export type ServerManagedRow<E extends string> = {
  id: Id<E>
  created_at: IsoUtc
  updated_at: IsoUtc
  created_by?: string
}

/** The complement of ServerManagedRow: the keys NO write body may carry,
 * derived from the same registry so that adding a managed field narrows
 * both write bodies automatically. Lives here rather than in either write
 * body's own file (contract/create-body.v1.ts, contract/update-patch.v1.ts)
 * because both need it and neither owns it — it is a projection of the
 * registry above, so the registry is its home.
 *
 * Naming one of these keys in a create or an update is PROHIBITED_FIELD on
 * the wire — deliberately a different code from UNKNOWN_FIELD, because the
 * field exists and simply is not the client's to set. Typing them as
 * optional-never makes the same mistake a compile error for a TypeScript
 * driver. */
export type NoServerManagedKeys = { [K in ServerManagedFieldName]?: never }

// ============================================================
// SERVER-MANAGED ENTITIES — tables the engine creates in every project
// database whether the project asked for them or not, because the system
// itself depends on them. Exactly one exists today.
//
// `users` is here because the access rules need somewhere to look: a
// '$caller.<usersField>' value in a rule reads "a field on the caller's
// users row", so that row has to exist in every project, in a table the
// project cannot fail to declare. It is a NORMAL entity plus one extra
// managed column: it gets the same four managed fields as every table —
// from SERVER_MANAGED_FIELDS above, one source — so nothing about it is
// special at verb time. The one addition is mythwork_id, unique but NOT
// the primary key, so a future project-scoped identifier could be added
// beside it without re-keying anything.
//
// The engine owns this entity's EXISTENCE, identically on the dev and prod
// instances: the shared bootstrap creates it under a reserved entity id
// before any schema operation can run, so the diff never emits a create or
// a delete for it — only field operations for its declared extensions.
//
// A project MAY extend it: entities/users.jsonc is a reserved filename, and
// declaring it adds fields (a team_id, a role enum, a prefs json) beside
// the engine's own. Managed columns are not redeclarable, and declared
// users fields are exactly what a rule's '$caller.<usersField>' may name.
// A display name or a last-seen timestamp is deliberately NOT core: a
// project that wants either declares it and manages it through its own
// flows — the engine never fills them from the platform profile.
//
// ROWS are engine-minted, never client-made: on the first authenticated
// call a person makes to an instance, the engine inserts their row (the
// ordinary managed stamps, created_by being their own id, plus mythwork_id
// from the verified caller — never from the request body). The same lookup
// that does this is what membership scopes read, so it costs no extra
// query. There is no create verb and no delete verb on users — the
// generated client simply does not emit them — so a project cannot invent
// or remove people; updates to DECLARED fields flow through the ordinary
// verb surface under whatever scope users.jsonc declares, which is closed
// unless it declares one.
// ============================================================
export const SERVER_MANAGED_ENTITIES = {
  users: {
    reservedFileName: 'entities/users.jsonc',
    // Born by the bootstrap under this id, so declared-entity minting
    // starts above it and the diff recognizes it without name tricks.
    reservedEntityId: 1,
    // The one managed column beyond the standard four. Unique — one row per
    // person per project — and filled at mint from the verified caller.
    extraManagedFields: {
      mythwork_id: { wire: WIRE_KINDS.string },
    },
    // The verbs this entity does NOT expose, whatever a users.jsonc says.
    absentVerbs: ['create', 'delete'],
  },
} as const
export type ServerManagedEntityName = keyof typeof SERVER_MANAGED_ENTITIES

export function isServerManagedEntityName(name: string): name is ServerManagedEntityName {
  return Object.hasOwn(SERVER_MANAGED_ENTITIES, name)
}
