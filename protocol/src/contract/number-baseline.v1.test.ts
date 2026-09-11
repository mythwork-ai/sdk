// The number baseline's pure half: deriving it from a stored schema
// record, the four questions the publish apply asks of it, and the
// fail-closed reading of one that arrives from storage. No runtime, no
// instance, no storage — the whole point of putting the arithmetic's
// inputs in one small shape is that it can be pinned this cheaply.

import { describe, expect, it } from 'vitest'
import {
  asNumberBaseline,
  baselineEntityNumber,
  baselineFieldNumber,
  highestEntityNumber,
  highestFieldNumber,
  numberBaselineFrom,
} from './number-baseline.v1'
import type { StoredSchema } from './schema-record.v1'

/** A stored record shaped exactly as an instance holds one, with the
 * parts the baseline must throw away — descriptions, field definitions,
 * access rules — actually present, so "nothing else" is a claim this
 * fixture can falsify. */
const RECORD = {
  entities: {
    users: {
      entityId: 1,
      description: 'the people of this project',
      fields: {},
      row_level_access: {},
    },
    note: {
      entityId: 2,
      description: 'a note',
      fields: {
        title: { fieldId: 1, def: { type: 'string', description: 'the title' } },
        body: { fieldId: 4, def: { type: 'string', description: 'the body' } },
      },
      row_level_access: { read: { scope: 'public' } },
    },
    tag: {
      entityId: 7,
      description: 'a tag',
      fields: { label: { fieldId: 2, def: { type: 'string', description: 'the label' } } },
      row_level_access: {},
    },
  },
} as unknown as StoredSchema

describe('numberBaselineFrom', () => {
  it('keeps every entity and field NUMBER, and nothing else', () => {
    expect(numberBaselineFrom(RECORD)).toEqual({
      entities: {
        users: { entityId: 1, fields: {} },
        note: { entityId: 2, fields: { title: 1, body: 4 } },
        tag: { entityId: 7, fields: { label: 2 } },
      },
    })
  })

  it('an empty record derives an empty baseline, which reserves nothing', () => {
    const empty = numberBaselineFrom({ entities: {} })
    expect(empty).toEqual({ entities: {} })
    expect(highestEntityNumber(empty)).toBe(0)
  })
})

describe('the high-water marks, which are COMPUTED and never stored', () => {
  const baseline = numberBaselineFrom(RECORD)

  it('the highest entity number is the largest one assigned, gaps and all', () => {
    // 7, not 3: the record's numbers are not dense, and minting above
    // the count instead of above the maximum would collide.
    expect(highestEntityNumber(baseline)).toBe(7)
  })

  it('the highest field number is per entity, not across the record', () => {
    expect(highestFieldNumber(baseline, 'note')).toBe(4)
    expect(highestFieldNumber(baseline, 'tag')).toBe(2)
    expect(highestFieldNumber(baseline, 'users')).toBe(0)
  })

  it('a name the baseline does not know has no high-water mark of its own', () => {
    expect(highestFieldNumber(baseline, 'todo')).toBe(0)
  })

  it('no baseline reserves nothing at all — the never-published project', () => {
    expect(highestEntityNumber(null)).toBe(0)
    expect(highestEntityNumber(undefined)).toBe(0)
    expect(highestFieldNumber(null, 'note')).toBe(0)
  })
})

describe('the two adoption lookups', () => {
  const baseline = numberBaselineFrom(RECORD)

  it('answer prod’s number for a name prod knows', () => {
    expect(baselineEntityNumber(baseline, 'tag')).toBe(7)
    expect(baselineFieldNumber(baseline, 'note', 'body')).toBe(4)
  })

  it('answer undefined for anything prod has never seen, so the caller mints', () => {
    expect(baselineEntityNumber(baseline, 'todo')).toBeUndefined()
    expect(baselineFieldNumber(baseline, 'note', 'extra')).toBeUndefined()
    // and a known field name on an unknown entity is still unknown
    expect(baselineFieldNumber(baseline, 'todo', 'body')).toBeUndefined()
  })

  it('answer undefined for every name when there is no baseline', () => {
    expect(baselineEntityNumber(null, 'note')).toBeUndefined()
    expect(baselineFieldNumber(null, 'note', 'title')).toBeUndefined()
  })
})

describe('names that are also members of Object.prototype', () => {
  // The declared-name grammar (engine/publish/parse-declared.v1.ts's
  // NAME_RE, /^[a-z][a-z0-9_]*$/) accepts `constructor`, so a builder or
  // a client can genuinely publish an entity and a field with that name.
  // A bare property read on the baseline's plain objects then finds the
  // INHERITED member instead of missing, and the readers below either
  // throw a raw TypeError — a bare 500 — or hand a function back as a
  // number, which is composed straight into a physical table name.
  const RECORD_WITH_PROTOTYPE_NAMES = {
    entities: {
      constructor: {
        entityId: 5,
        description: 'an entity a client is entitled to call this',
        fields: { constructor: { fieldId: 3, def: { type: 'string', description: 'a field' } } },
        row_level_access: {},
      },
    },
  } as unknown as StoredSchema

  const baseline = numberBaselineFrom(RECORD_WITH_PROTOTYPE_NAMES)

  it('derive as ordinary entries, because the name is ordinary', () => {
    expect(baseline).toEqual({
      entities: { constructor: { entityId: 5, fields: { constructor: 3 } } },
    })
  })

  it('are looked up as themselves, never as the inherited member', () => {
    expect(baselineEntityNumber(baseline, 'constructor')).toBe(5)
    expect(baselineFieldNumber(baseline, 'constructor', 'constructor')).toBe(3)
    expect(highestFieldNumber(baseline, 'constructor')).toBe(3)
  })

  it('and on a baseline that does NOT know the name, answer plainly instead of throwing', () => {
    const other = numberBaselineFrom(RECORD)
    expect(baselineEntityNumber(other, 'constructor')).toBeUndefined()
    expect(baselineFieldNumber(other, 'note', 'constructor')).toBeUndefined()
    expect(baselineFieldNumber(other, 'constructor', 'title')).toBeUndefined()
    expect(highestFieldNumber(other, 'constructor')).toBe(0)
  })
})

describe('asNumberBaseline: the fail-closed reading of a stored baseline', () => {
  it('accepts the shape the derivation produces, unchanged', () => {
    const derived = numberBaselineFrom(RECORD)
    expect(asNumberBaseline(JSON.parse(JSON.stringify(derived)))).toEqual(derived)
    expect(asNumberBaseline({ entities: {} })).toEqual({ entities: {} })
  })

  it('reads a MISSING entity number as no baseline at all, rather than as NaN', () => {
    // The exact stored corruption that composed `CREATE TABLE eNaN`:
    // an entry with fields but no entityId. Math.max over undefined is
    // NaN, and `e${NaN}` is a table name that will never be found again.
    const missing = { entities: { note: { fields: { title: 1 } } } }
    expect(asNumberBaseline(missing)).toBeNull()
    expect(highestEntityNumber(asNumberBaseline(missing))).toBe(0)
  })

  it('reads a missing FIELD number the same way', () => {
    expect(
      asNumberBaseline({ entities: { note: { entityId: 2, fields: { title: null } } } }),
    ).toBeNull()
  })

  it('refuses numbers that could never be a physical name', () => {
    const withEntityNumber = (entityId: unknown) => ({
      entities: { note: { entityId, fields: {} } },
    })
    expect(asNumberBaseline(withEntityNumber('2'))).toBeNull()
    expect(asNumberBaseline(withEntityNumber(2.5))).toBeNull()
    expect(asNumberBaseline(withEntityNumber(-2))).toBeNull()
    expect(asNumberBaseline(withEntityNumber(0))).toBeNull()
    expect(asNumberBaseline(withEntityNumber(Number.NaN))).toBeNull()
    expect(asNumberBaseline(withEntityNumber(Number.POSITIVE_INFINITY))).toBeNull()
  })

  it('refuses anything that is not the shape at all', () => {
    expect(asNumberBaseline(null)).toBeNull()
    expect(asNumberBaseline('a baseline, honest')).toBeNull()
    expect(asNumberBaseline([])).toBeNull()
    expect(asNumberBaseline({})).toBeNull()
    expect(asNumberBaseline({ entities: [] })).toBeNull()
    expect(asNumberBaseline({ entities: { note: 2 } })).toBeNull()
    expect(asNumberBaseline({ entities: { note: { entityId: 2 } } })).toBeNull()
  })
})
