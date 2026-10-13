import { describe, expect, it } from 'vitest'
import { isTermsToken, parseSignInHint, TERMS_VERSION } from './terms'

describe('parseSignInHint', () => {
  it('keeps well-formed fields', () => {
    expect(parseSignInHint({ intent: 'signup', acceptedTerms: TERMS_VERSION })).toEqual({
      intent: 'signup',
      acceptedTerms: TERMS_VERSION,
    })
    expect(parseSignInHint({ intent: 'signin' })).toEqual({ intent: 'signin' })
  })

  it('drops malformed fields and ignores anything else', () => {
    expect(
      parseSignInHint({ type: 'oc-signin-gesture', intent: 'SIGNUP', acceptedTerms: '2026/09/16' }),
    ).toEqual({})
    expect(parseSignInHint({ intent: ['signup'], acceptedTerms: 20260916 })).toEqual({})
  })

  it('treats a non-object, such as a click event stand-in, as no hint', () => {
    expect(parseSignInHint(undefined)).toEqual({})
    expect(parseSignInHint(null)).toEqual({})
    expect(parseSignInHint('signup')).toEqual({})
    expect(parseSignInHint({ target: {}, type: 'click' })).toEqual({})
  })
})

describe('isTermsToken', () => {
  it('accepts the current version and rejects anything outside 1-32 of [0-9A-Za-z-]', () => {
    expect(isTermsToken(TERMS_VERSION)).toBe(true)
    expect(isTermsToken('x'.repeat(32))).toBe(true)
    expect(isTermsToken('x'.repeat(33))).toBe(false)
    expect(isTermsToken('')).toBe(false)
    expect(isTermsToken('2026-09-16\n')).toBe(false)
    expect(isTermsToken('<b>')).toBe(false)
  })
})
