// THE NUMBER BASELINE: what a project's PROD record already decided
// about entity and field numbers, in the smallest shape that decides
// them, so a dev instance can adopt those decisions instead of minting
// its own and colliding.
//
// WHY THIS EXISTS AT ALL. Entity and field numbers — the ones that become
// the physical names e3 and f7 — are minted server-side wherever the
// publish apply runs. There is no lockfile, and the PROD record is the
// authority for which number belongs to which name. A dev instance is
// born lazily at its first schema write and reborn after every idle
// self-delete, and each time it starts from empty storage; left to
// itself it would mint from zero and hand a name a number prod has
// already given to something else. So at birth it ADOPTS prod's existing
// assignments and mints only above prod's high-water mark. Then a later
// publish maps cleanly, because for every shared name the two records
// agree on the number, and no dev-minted number can equal a prod one.
//
// WHAT IS IN IT, AND NOTHING MORE: for each entity name its number, and
// for each of that entity's field names that field's number. No
// descriptions, no field definitions, no rules — none of that
// participates in the arithmetic, and carrying it would make this a
// second copy of the schema record with its own chance of drifting.
//
// THE HIGH-WATER MARKS ARE COMPUTED, NEVER STORED. `highestEntityNumber`
// and `highestFieldNumber` below walk the baseline every time they are
// asked. Storing them beside the assignments would create two facts that
// can disagree, and the disagreement's symptom would be a collided
// physical column name — the kind of corruption that shows up much later
// as unexplained data in the wrong place.
//
// VERSIONING: this shape is BOTH persisted (a dev instance's birth fact
// in its meta table, whose layout host/bootstrap.v1.ts owns) AND carried
// on the worker-to-instance hop, so it is version-named. It is never
// visible to a client.

import type { EntityName, FieldName } from './entity.types.v1'
import type { StoredSchema } from './schema-record.v1'

/** One entity's assignments, keyed by the entity's CURRENT name in the
 * prod record — the same key the stored record uses. */
export type EntityNumberBaseline = {
  entityId: number
  fields: Record<FieldName, number>
}

export type NumberBaseline = {
  entities: Record<EntityName, EntityNumberBaseline>
}

/** THE pure derivation, from a stored schema record to the baseline it
 * implies. Takes only the `entities` half, because that is what the
 * instance's schema read answers with and it is all the arithmetic
 * needs. */
export function numberBaselineFrom(schema: Pick<StoredSchema, 'entities'>): NumberBaseline {
  const entities: Record<EntityName, EntityNumberBaseline> = {}
  for (const [name, entity] of Object.entries(schema.entities)) {
    const fields: Record<FieldName, number> = {}
    for (const [fieldName, field] of Object.entries(entity.fields)) {
      fields[fieldName] = field.fieldId
    }
    entities[name] = { entityId: entity.entityId, fields }
  }
  return { entities }
}

// OWN PROPERTIES ONLY, on every lookup below. The names being looked up
// are entity and field names out of a client's declaration, and the name
// grammar that admits them (engine/publish/parse-declared.v1.ts's
// NAME_RE) accepts `constructor` — so a bare property read on these
// plain objects finds the inherited prototype member instead of missing.
// engine/context.ts's resolveEntity guards the same hazard on the same
// kind of client-controlled name, and this is the same guard for the
// same reason. Here the consequence is worse than a wrong answer: two of
// the readers below would then read `.fields` off a function and throw a
// raw TypeError, which escapes the request as a bare 500, and a third
// would hand a FUNCTION back as an entity's number and compose it into a
// physical table name.
function own<T>(record: Record<string, T>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined
}

/** One entity's assignments by name, or undefined when the baseline is
 * absent or does not know the name — THE one entity-name lookup the
 * three readers below share. */
function entityIn(
  baseline: NumberBaseline | null | undefined,
  entityName: string,
): EntityNumberBaseline | undefined {
  if (baseline === null || baseline === undefined) return undefined
  return own(baseline.entities, entityName)
}

/** The highest entity number the baseline assigns, or 0 when there is no
 * baseline — which is a project that has never published, and reads as
 * "nothing is reserved, mint from the bottom as always". Walks the
 * baseline's OWN entries only, which is what Object.values already
 * guarantees, so there is no name lookup here to guard. */
export function highestEntityNumber(baseline: NumberBaseline | null | undefined): number {
  if (baseline === null || baseline === undefined) return 0
  return Math.max(0, ...Object.values(baseline.entities).map(e => e.entityId))
}

/** The highest field number the baseline assigns WITHIN one entity, by
 * that entity's name, or 0 when the baseline does not know the name. */
export function highestFieldNumber(
  baseline: NumberBaseline | null | undefined,
  entityName: string,
): number {
  const entity = entityIn(baseline, entityName)
  if (entity === undefined) return 0
  return Math.max(0, ...Object.values(entity.fields))
}

/** The number the baseline already gave this entity name, or undefined
 * when prod has never seen the name — in which case the caller mints. */
export function baselineEntityNumber(
  baseline: NumberBaseline | null | undefined,
  entityName: string,
): number | undefined {
  return entityIn(baseline, entityName)?.entityId
}

/** The number the baseline already gave this field name on this entity,
 * or undefined when either name is new to prod. */
export function baselineFieldNumber(
  baseline: NumberBaseline | null | undefined,
  entityName: string,
  fieldName: string,
): number | undefined {
  const entity = entityIn(baseline, entityName)
  return entity === undefined ? undefined : own(entity.fields, fieldName)
}

/** THE one place a loose value becomes a baseline — whichever direction
 * it arrived from (the persisted birth fact, the worker→instance hop).
 *
 * FAIL CLOSED, to NO baseline: anything that is not exactly this shape,
 * to the last number, reads as null. The alternative is arithmetic over
 * a missing or non-numeric assignment, which produces NaN and composes
 * the physical table name `eNaN` — a publish that either fails with an
 * unreadable SQL error or, worse, half-succeeds. This is the same care
 * host/instance-role.v1.ts's `asInstanceRole` takes over the other
 * stored fact that decides behaviour: an instance that cannot say what
 * its baseline is must behave as though it has none.
 *
 * Null means "mint from the bottom", which is exactly what a
 * never-published project's dev instance does, so degrading to it is a
 * state the system already handles rather than a new one. The cost of
 * that degradation is real and worth naming: a dev instance that loses
 * its baseline can mint a number prod has already assigned, and the
 * collision surfaces at the next publish rather than here. Refusing
 * every publish forever is the only other option and is worse. */
export function asNumberBaseline(value: unknown): NumberBaseline | null {
  if (!isPlainObject(value)) return null
  const entities = (value as { entities?: unknown }).entities
  if (!isPlainObject(entities)) return null
  const checked: Record<EntityName, EntityNumberBaseline> = {}
  for (const [name, entity] of Object.entries(entities)) {
    if (!isPlainObject(entity)) return null
    const entityId = (entity as { entityId?: unknown }).entityId
    const fields = (entity as { fields?: unknown }).fields
    if (!isAssignedNumber(entityId) || !isPlainObject(fields)) return null
    for (const fieldId of Object.values(fields)) {
      if (!isAssignedNumber(fieldId)) return null
    }
    checked[name] = { entityId, fields: fields as Record<FieldName, number> }
  }
  return { entities: checked }
}

/** An assignment is a whole positive number: it is about to be spliced
 * into a physical name, so a fraction, a negative, an infinity, and NaN
 * are all equally unusable. */
function isAssignedNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
