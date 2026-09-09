// The rules BOTH hosts apply to an app's metadata, and to the job ids that
// address a run of it. Pure functions and constants over plain values: they are
// part of the contract, not of one implementation of it, so the real host frame
// and the dev host refuse exactly the same things. See PR #859.

import type { AppTheme } from './methods'

/**
 * Every style id an {@link AppTheme} may name: mythcode's eight builtin presets,
 * in its own order (`elegant` is labelled "Editorial" in its UI).
 *
 * A run can also generate presets of its own and offer them through a
 * `theme_options` event; those ids exist only inside the run that produced them
 * — mythcode answers 400 for one on any other job — so they are not accepted
 * here. Widening this list later is additive.
 */
export const APP_THEME_STYLES = [
  'modern',
  'kid-friendly',
  'brutalist',
  'ai',
  'flat',
  'wireframe',
  'retro',
  'elegant',
] as const

/** One of {@link APP_THEME_STYLES}. */
export type AppThemeStyle = (typeof APP_THEME_STYLES)[number]

/**
 * Narrow a string to an {@link AppThemeStyle} — for a caller holding one that
 * came from outside the type system (a URL parameter, a stored preference, a
 * picker's value) and needing to know whether it can be sent.
 */
export function isAppThemeStyle(value: unknown): value is AppThemeStyle {
  return typeof value === 'string' && (APP_THEME_STYLES as readonly string[]).includes(value)
}

/** Exactly the fields an {@link AppTheme} may carry. */
const THEME_KEYS = new Set(['style', 'hue', 'secondaryHue', 'mode'])

/**
 * Validate an unknown value into an {@link AppTheme}, or `null`.
 *
 * UNKNOWN KEYS ARE REJECTED, not stripped, mirroring mythcode's strict decoder:
 * a caller that sends `secondaryhue` has a typo, and dropping it silently would
 * apply a theme they did not ask for and report success. Hues are stored as
 * given, not folded — every renderer path normalises them itself.
 */
export function parseAppTheme(value: unknown): AppTheme | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const t = value as Record<string, unknown>
  for (const key of Object.keys(t)) {
    if (!THEME_KEYS.has(key)) return null
  }
  if (!isAppThemeStyle(t.style)) return null
  if (typeof t.hue !== 'number' || !Number.isFinite(t.hue)) return null
  if (t.mode !== 'light' && t.mode !== 'dark') return null
  const theme: AppTheme = { style: t.style, hue: t.hue, mode: t.mode }
  if (t.secondaryHue !== undefined) {
    if (typeof t.secondaryHue !== 'number' || !Number.isFinite(t.secondaryHue)) return null
    theme.secondaryHue = t.secondaryHue
  }
  return theme
}

/** Longest app display name accepted, in characters. */
export const APP_NAME_MAX_CHARS = 200

/**
 * Validate an unknown value into the trimmed display name that gets applied, or
 * `null`. Bounded because it lands in a running app's `<title>`.
 */
export function parseAppName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  if (!name || name.length > APP_NAME_MAX_CHARS) return null
  return name
}

/**
 * mythcode's `sanitizeID`, mirrored: lower-case, `[a-z0-9_-]` kept, everything
 * else becomes `-`.
 */
export function sanitizeMythcodeId(s: string): string {
  let out = ''
  for (const ch of s.trim()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_') out += ch
    else if (ch >= 'A' && ch <= 'Z') out += ch.toLowerCase()
    else out += '-'
  }
  return out
}

/**
 * True when `jobId` has mythcode's exact job-id shape AND names an app whose id
 * is `projectId`. mythcode mints a job id as `<sanitized appID>-<base36>` plus
 * an optional `.<instance>` (`internal/jobserver/queue.go`), and `appID` is the
 * mythwork project id, so the pair is decidable here.
 *
 * EXACT ON PURPOSE: mythcode reads the assertion's `project` claim into its
 * request context and no route compares it with the job's app id, so this is
 * the only thing between a project-scoped assertion and another project's job.
 * A prefix test alone accepts `abc-x-lz3k9a1` — a well-formed job id of the
 * DIFFERENT app `abc-x` — which is why the base36 suffix is checked too.
 */
export function jobBelongsToProject(jobId: string, projectId: string): boolean {
  if (typeof jobId !== 'string') return false
  const app = sanitizeMythcodeId(projectId)
  if (app === '') return false
  // `.instance` is mythcode's own suffix for a re-run of the same job; strip it
  // before looking at the id proper.
  const dot = jobId.indexOf('.')
  const base = dot === -1 ? jobId : jobId.slice(0, dot)
  if (dot !== -1 && !/^[A-Za-z0-9_-]+$/.test(jobId.slice(dot + 1))) return false
  if (!base.startsWith(`${app}-`)) return false
  return /^[0-9a-z]+$/.test(base.slice(app.length + 1))
}
