import { describe, expect, it } from 'vitest'
import {
  ACCESS_COMPARISONS,
  ACCESS_SCOPE_KINDS,
  classifyMatches,
  SENTINELS,
} from './entity.types.v1'

describe('the canonical access-rule strings', () => {
  it('pins the exact wire strings — these are written into entity files and travel in requests', () => {
    expect([...ACCESS_SCOPE_KINDS]).toEqual(['public', 'authenticated', 'ownerOnly', 'field'])
    // deliberately quoted literals HERE and only here: this test is the
    // tripwire that notices if the constant objects' values ever change
    expect([...ACCESS_COMPARISONS]).toEqual(['equals', 'contains'])
    expect(SENTINELS.caller).toBe('$caller')
    expect(SENTINELS.provided).toBe('$provided')
    expect(SENTINELS.callerUsersFieldPrefix).toBe('$caller.')
  })
})

describe('classifyMatches — the one interpreter of the sentinel strings', () => {
  it('tells the five cases apart', () => {
    expect(classifyMatches('$caller')).toEqual({ kind: 'callerId' })
    expect(classifyMatches('$provided')).toEqual({ kind: 'provided' })
    expect(classifyMatches('$caller.department')).toEqual({
      kind: 'callerUsersField',
      usersField: 'department',
    })
    expect(classifyMatches('published')).toEqual({ kind: 'literal', value: 'published' })
    expect(classifyMatches(0)).toEqual({ kind: 'literal', value: 0 })
    expect(classifyMatches(false)).toEqual({ kind: 'literal', value: false })
    expect(classifyMatches(['draft', 'review'])).toEqual({
      kind: 'oneOf',
      values: ['draft', 'review'],
    })
  })

  it('a list is always one-of literals — a sentinel-looking member is just a string', () => {
    // sentinels never combine with one-of; publish rejects such a rule,
    // and until then the member compares as the literal text, which no
    // real user id or presented value is expected to equal
    expect(classifyMatches(['$caller'])).toEqual({ kind: 'oneOf', values: ['$caller'] })
  })
})
