// These rules are shared by the host frame and the dev host, so what they accept
// IS the contract — a difference between the two would let an app pass in
// development and fail in production.
import { describe, expect, it } from 'vitest'

import {
  APP_THEME_STYLES,
  jobBelongsToProject,
  parseAppName,
  parseAppTheme,
  sanitizeMythcodeId,
} from './app-metadata'

describe('parseAppTheme', () => {
  it('accepts every builtin style, keeps finite degrees as given, and only those', () => {
    for (const style of APP_THEME_STYLES) {
      expect(parseAppTheme({ style, hue: 1, mode: 'light' })?.style, style).toBe(style)
    }
    expect(parseAppTheme({ style: 'ai', hue: -40, secondaryHue: 0, mode: 'dark' })).toEqual({
      style: 'ai',
      hue: -40,
      secondaryHue: 0,
      mode: 'dark',
    })
    // A generated per-run preset id exists only inside the run that made it.
    expect(parseAppTheme({ style: 'gen-a1b2c3', hue: 1, mode: 'light' })).toBeNull()
    expect(parseAppTheme({ style: 'modern', hue: 1 })).toBeNull()
    expect(parseAppTheme({ style: 'modern', hue: Number.NaN, mode: 'light' })).toBeNull()
    expect(parseAppTheme({ style: 'modern', hue: 1, mode: 'sepia' })).toBeNull()
  })

  it('REFUSES an unknown key rather than stripping it', () => {
    // The typo this exists for: `secondaryhue` would otherwise be dropped and
    // the caller told the theme applied, with an accent they never chose.
    expect(parseAppTheme({ style: 'modern', hue: 10, mode: 'light', secondaryhue: 20 })).toBeNull()
  })
})

describe('parseAppName', () => {
  it('trims, and bounds the trimmed value at 200 characters', () => {
    expect(parseAppName('  Quote Corner \n')).toBe('Quote Corner')
    expect(parseAppName(`  ${'x'.repeat(200)}  `)).toBe('x'.repeat(200))
    expect(parseAppName('x'.repeat(201))).toBeNull()
    for (const value of ['', '   ', 42, null, undefined]) {
      expect(parseAppName(value), String(value)).toBeNull()
    }
  })
})

// Moved here with the function itself: both hosts need it, and it is the whole
// of the jobId/pid enforcement (mythcode does not check it on its side).
describe('jobBelongsToProject', () => {
  it('sanitizes a project id the way mythcode does', () => {
    expect(sanitizeMythcodeId(' pTARGET.x/y ')).toBe('ptarget-x-y')
  })

  it("accepts mythcode's own shape: <sanitized app>-<base36>[.<instance>]", () => {
    expect(jobBelongsToProject('ptarget-lz3k9a1', 'pTARGET')).toBe(true)
    expect(jobBelongsToProject('ptarget-lz3k9a1.retry-1', 'pTARGET')).toBe(true)
  })

  // A prefix test hands `abc-x`'s job to `abc`; the hyphen-free suffix closes it.
  it('refuses a job of a DIFFERENT app that merely starts the same way', () => {
    expect(jobBelongsToProject('abc-x-lz3k9a1', 'abc')).toBe(false)
    expect(jobBelongsToProject('abc-x-lz3k9a1', 'abc-x')).toBe(true)
  })

  it('refuses another project, a bare app id, an empty suffix and a bad shape', () => {
    for (const [jobId, projectId] of [
      ['pother-lz3k9a1', 'pTARGET'],
      ['ptargetx-lz3k9a1', 'pTARGET'],
      ['ptarget', 'pTARGET'],
      ['ptarget-', 'pTARGET'],
      ['ptarget-a/b', 'pTARGET'],
      ['ptarget-LZ3K9A1', 'pTARGET'],
      ['ptarget-lz3.a/b', 'pTARGET'],
      ['ptarget-lz3k9a1', ''],
      [7 as never, 'pTARGET'],
    ] as Array<[string, string]>) {
      expect(jobBelongsToProject(jobId, projectId)).toBe(false)
    }
  })
})
