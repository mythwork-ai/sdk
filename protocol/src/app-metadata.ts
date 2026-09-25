// The rules BOTH hosts apply to an app's metadata, and to the job ids that
// address a run of it. Pure functions and constants over plain values: they are
// part of the contract, not of one implementation of it, so the real host frame
// and the dev host refuse exactly the same things. See PR #859.

import type { AppTheme, BuildRequestMethod } from './methods'

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

/** Longest project workflow accepted, in characters. */
export const PROJECT_WORKFLOW_MAX_CHARS = 200

/**
 * Validate an unknown value into the trimmed workflow a project is created
 * with: `undefined` when absent or blank, `null` when not a string or longer
 * than {@link PROJECT_WORKFLOW_MAX_CHARS}.
 */
export function parseProjectWorkflow(value: unknown): string | undefined | null {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  const workflow = value.trim()
  if (!workflow) return undefined
  return workflow.length > PROJECT_WORKFLOW_MAX_CHARS ? null : workflow
}

/** Longest `type` a {@link MethodMap['build.request']} may name, in characters. */
export const JOB_REQUEST_TYPE_MAX_CHARS = 200

/** Every character a `build.request` `type` may contain. */
const JOB_REQUEST_TYPE_CHARS = /^[A-Za-z0-9._~/-]+$/

/**
 * Validate a `build.request` `type` into the path segments that get appended to
 * the session's OWN job, or `null`.
 *
 * The caller names only what comes after `/jobs/{id}/`, and this is the whole
 * defence for that: the job id and the base URL are the host's, so a `type` that
 * could climb out of the job's prefix, or carry its own query, fragment, scheme
 * or authority, would reach a route the caller was never granted. Rejected
 * rather than escaped, because every legal route mythcode publishes is already
 * within this alphabet — `history/restore` is the shape that needs the slash.
 *
 * `%` is not in the alphabet either: a percent-escape would otherwise let `%2e%2e`
 * become `..` at whichever hop decodes it first.
 */
export function parseJobRequestType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value === '' || value.length > JOB_REQUEST_TYPE_MAX_CHARS) return null
  if (!JOB_REQUEST_TYPE_CHARS.test(value)) return null
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
  }
  return value
}

/** Every HTTP method a `build.request` may use. */
export const JOB_REQUEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * Validate a `build.request` `method`, defaulting an absent one to `POST` (the
 * method every control route mythcode publishes today takes). Returns `null`
 * for anything else, including a lower-case spelling — the value goes straight
 * into `fetch`, so it is a fixed list, not a normalisation.
 */
export function parseJobRequestMethod(value: unknown): BuildRequestMethod | null {
  if (value === undefined) return 'POST'
  if (typeof value !== 'string') return null
  return (JOB_REQUEST_METHODS as readonly string[]).includes(value)
    ? (value as BuildRequestMethod)
    : null
}

/** Most query parameters a `build.request` may carry, and their total size. */
export const JOB_REQUEST_QUERY_MAX_PARAMS = 32
export const JOB_REQUEST_QUERY_MAX_CHARS = 2048

/**
 * Validate a `build.request` `query` into the pairs the host will encode, or
 * `null` for an invalid one; an absent query is the empty set. Values are NOT
 * restricted in alphabet: the host builds the query string with
 * `URLSearchParams`, never by concatenation, so an `&` or a `#` in a value is
 * escaped rather than smuggled. Bounded only so one call cannot build an
 * unreasonable URL.
 */
export function parseJobRequestQuery(value: unknown): Record<string, string> | null {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > JOB_REQUEST_QUERY_MAX_PARAMS) return null
  let size = 0
  const query: Record<string, string> = {}
  for (const [key, v] of entries) {
    if (key === '' || typeof v !== 'string') return null
    size += key.length + v.length
    if (size > JOB_REQUEST_QUERY_MAX_CHARS) return null
    query[key] = v
  }
  return query
}

/**
 * How long a `build.request` waits for its answer when the caller says nothing,
 * and the longest it may be asked to wait.
 *
 * The default is for an ordinary control route, which answers at once. The
 * maximum is for the other shape these routes take: one HELD open until the
 * thing asked for exists — a name or a theme the build has not suggested yet —
 * which is how an engine-to-client notification is delivered here without a
 * second push channel. Five minutes, because a held request that outlives a
 * whole build stops being a wait and starts being a leak, and asking again is
 * one line for the caller.
 */
export const JOB_REQUEST_DEFAULT_TIMEOUT_MS = 30_000
export const JOB_REQUEST_MAX_TIMEOUT_MS = 300_000

/**
 * How much longer than `timeoutMs` the SDK gives the RPC round trip before its
 * own deadline fires. The host's timeout is the one that should decide a held
 * request, because it produces a RESULT the caller can act on; the transport's
 * produces a thrown error and a cancel. Five seconds is room for the postMessage
 * hop and the reply, not for another wait.
 */
export const JOB_REQUEST_REPLY_MARGIN_MS = 5_000

/**
 * Validate a `build.request` `timeoutMs`, defaulting an absent one. Whole
 * milliseconds, at least one, no more than {@link JOB_REQUEST_MAX_TIMEOUT_MS};
 * `null` for anything else, including a larger number — a caller asking to wait
 * longer than the cap is told so rather than quietly held to the cap.
 */
export function parseJobRequestTimeout(value: unknown): number | null {
  if (value === undefined) return JOB_REQUEST_DEFAULT_TIMEOUT_MS
  if (typeof value !== 'number' || !Number.isInteger(value)) return null
  if (value < 1 || value > JOB_REQUEST_MAX_TIMEOUT_MS) return null
  return value
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
