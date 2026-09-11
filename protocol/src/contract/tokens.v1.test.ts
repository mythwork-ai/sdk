import { describe, expect, it } from 'vitest'
import { FIELD_KINDS } from './entity.types.v1'
import { config } from './config'
import { CHECK_KEYS, CHECKS, CONDITION_OPERATORS, DEFAULT_TOKENS, OPERATORS } from './tokens.v1'

// This file is contract-plane and reaches the generated client: it must
// contain vocabulary facts only. The pin below is the tripwire for the
// canonical $ strings; the SQL for these operators lives engine-side and
// is pinned there.

describe('the canonical $ strings', () => {
  it('pins the exact wire strings', () => {
    expect(Object.values(OPERATORS)).toEqual(['$in', '$gte', '$gt', '$lte', '$lt'])
    expect(Object.values(CHECKS)).toEqual(['$gte', '$gt', '$lte', '$lt', '$integer'])
    expect(Object.keys(DEFAULT_TOKENS)).toEqual(['$now'])
  })
})

describe('which kinds each operator admits', () => {
  it('ranges fit only the ordered kinds', () => {
    for (const op of [OPERATORS.gte, OPERATORS.gt, OPERATORS.lte, OPERATORS.lt]) {
      expect(CONDITION_OPERATORS[op].admits(FIELD_KINDS.number)).toBe(true)
      expect(CONDITION_OPERATORS[op].admits(FIELD_KINDS.datetime)).toBe(true)
      expect(CONDITION_OPERATORS[op].admits(FIELD_KINDS.string)).toBe(false)
      expect(CONDITION_OPERATORS[op].admits(FIELD_KINDS.enum)).toBe(false)
    }
  })

  it('one-of fits every scalar and never json', () => {
    expect(CONDITION_OPERATORS[OPERATORS.in].admits(FIELD_KINDS.string)).toBe(true)
    expect(CONDITION_OPERATORS[OPERATORS.in].admits(FIELD_KINDS.boolean)).toBe(true)
    expect(CONDITION_OPERATORS[OPERATORS.in].admits(FIELD_KINDS.json)).toBe(false)
  })

  it('the one-of ceiling comes from config, not a literal', () => {
    expect(CONDITION_OPERATORS[OPERATORS.in].maxValues()).toBe(config.inListMax)
  })

  it('the one dynamic default admits only datetime', () => {
    expect(DEFAULT_TOKENS.$now.admits(FIELD_KINDS.datetime)).toBe(true)
    expect(DEFAULT_TOKENS.$now.admits(FIELD_KINDS.string)).toBe(false)
  })
})

describe('the check keys evaluate as declared', () => {
  it('bounds and whole-number-ness', () => {
    expect(CHECK_KEYS[CHECKS.gte].evaluate(1, 1)).toBe(true)
    expect(CHECK_KEYS[CHECKS.gt].evaluate(1, 1)).toBe(false)
    expect(CHECK_KEYS[CHECKS.lte].evaluate(1, 1)).toBe(true)
    expect(CHECK_KEYS[CHECKS.lt].evaluate(1, 1)).toBe(false)
    expect(CHECK_KEYS[CHECKS.integer].evaluate(1.5, true)).toBe(false)
    expect(CHECK_KEYS[CHECKS.integer].evaluate(2, true)).toBe(true)
    // false follows the flag convention: a no-op, same as absent
    expect(CHECK_KEYS[CHECKS.integer].evaluate(1.5, false)).toBe(true)
  })
})
