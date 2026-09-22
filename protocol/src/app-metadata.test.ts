// These rules are shared by the host frame and the dev host, so what they accept
// IS the contract — a difference between the two would let an app pass in
// development and fail in production.
import { describe, expect, it } from 'vitest'

import {
  APP_THEME_STYLES,
  JOB_REQUEST_QUERY_MAX_CHARS,
  JOB_REQUEST_QUERY_MAX_PARAMS,
  JOB_REQUEST_TYPE_MAX_CHARS,
  jobBelongsToProject,
  parseAppName,
  parseAppTheme,
  JOB_REQUEST_DEFAULT_TIMEOUT_MS,
  JOB_REQUEST_MAX_TIMEOUT_MS,
  parseJobRequestMethod,
  parseJobRequestQuery,
  parseJobRequestTimeout,
  parseJobRequestType,
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

describe('parseJobRequestType', () => {
  it('accepts the route shapes mythcode publishes', () => {
    for (const type of [
      'theme',
      'name',
      'style-groups',
      'element-style',
      'history',
      'history/restore',
      'runtime-health',
      'db',
      'a.b~c_d',
      'a'.repeat(JOB_REQUEST_TYPE_MAX_CHARS),
    ]) {
      expect(parseJobRequestType(type), type).toBe(type)
    }
  })

  it('refuses everything that could leave the job it is scoped to', () => {
    for (const type of [
      // Climbing out of /jobs/{id}/, directly or through an empty segment.
      '..',
      '../other',
      'history/../../jobs/other/theme',
      'history/./restore',
      'history//restore',
      '/theme',
      'theme/',
      // Naming somewhere else entirely.
      'http://evil.example/theme',
      '//evil.example/theme',
      'evil.example:8080/theme',
      // Carrying its own query or fragment.
      'theme?job=other',
      'theme#frag',
      // Escapes that a later hop would decode back into the two above.
      'history/%2e%2e/theme',
      'theme%3Fjob=other',
      'theme\\name',
      // Nothing at all, or more than a route.
      '',
      ' theme',
      'a'.repeat(JOB_REQUEST_TYPE_MAX_CHARS + 1),
      7 as never,
      null as never,
      undefined as never,
      { toString: () => 'theme' } as never,
    ]) {
      expect(parseJobRequestType(type), String(type)).toBe(null)
    }
  })
})

describe('parseJobRequestMethod', () => {
  it('defaults an absent method to POST and takes the five it knows', () => {
    expect(parseJobRequestMethod(undefined)).toBe('POST')
    for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(parseJobRequestMethod(m), m).toBe(m)
    }
  })

  it('refuses anything else, including a lower-case spelling', () => {
    for (const m of ['get', 'post', 'HEAD', 'OPTIONS', 'TRACE', '', 7 as never, null as never]) {
      expect(parseJobRequestMethod(m), String(m)).toBe(null)
    }
  })
})

describe('parseJobRequestQuery', () => {
  it('reads an absent query as the empty set and keeps string pairs as given', () => {
    expect(parseJobRequestQuery(undefined)).toEqual({})
    expect(parseJobRequestQuery({})).toEqual({})
    // Values are NOT filtered: the host encodes them, so a separator in one is
    // escaped rather than smuggled into the URL.
    expect(parseJobRequestQuery({ limit: '20', q: 'a&b=c#d' })).toEqual({
      limit: '20',
      q: 'a&b=c#d',
    })
  })

  it('refuses a non-object, a non-string value, an empty key and an oversized query', () => {
    const tooMany: Record<string, string> = {}
    for (let i = 0; i <= JOB_REQUEST_QUERY_MAX_PARAMS; i++) tooMany[`k${i}`] = 'v'
    for (const query of [
      null,
      'limit=20',
      ['limit', '20'],
      { limit: 20 },
      { limit: null },
      { '': 'v' },
      tooMany,
      { q: 'x'.repeat(JOB_REQUEST_QUERY_MAX_CHARS + 1) },
    ]) {
      expect(parseJobRequestQuery(query), JSON.stringify(query)).toBe(null)
    }
  })
})

describe('parseJobRequestTimeout', () => {
  it('defaults an absent wait and takes any whole number up to the cap', () => {
    expect(parseJobRequestTimeout(undefined)).toBe(JOB_REQUEST_DEFAULT_TIMEOUT_MS)
    for (const ms of [1, 1000, JOB_REQUEST_MAX_TIMEOUT_MS]) {
      expect(parseJobRequestTimeout(ms), String(ms)).toBe(ms)
    }
  })

  it('refuses a wait past the cap rather than shortening it, and anything not a whole ms', () => {
    for (const ms of [
      JOB_REQUEST_MAX_TIMEOUT_MS + 1,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '30000' as never,
      null as never,
    ]) {
      expect(parseJobRequestTimeout(ms), String(ms)).toBe(null)
    }
  })
})
