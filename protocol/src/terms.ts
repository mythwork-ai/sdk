/**
 * The sign-up Terms checkbox copy, shared by every surface that renders it
 * (the host-frame dialog and the auth worker's /google/callback page) so the
 * wording a user agreed to is one string, not two that drift.
 *
 * Links always point at mythwork.ai — the platform owns the legal documents,
 * so staging and preview zones link there too. The copy is AGE-254's,
 * verbatim.
 */

export const TERMS_URL = 'https://mythwork.ai/terms'
export const PRIVACY_URL = 'https://mythwork.ai/privacy'

/**
 * The current Terms version. It matches the "Last updated" date on
 * mythwork.ai/terms; bump it with the Terms so new accounts record the version
 * they actually saw. Only a sign-up records it, so bumping it asks no
 * existing account again.
 *
 * It lives here, not only in the auth worker, because the platform's own app
 * shows the checkbox before Google opens and sends the version it showed as
 * {@link SignInHint.acceptedTerms}. The auth worker records that acceptance
 * only when it equals this value; a stale app falls back to the worker's own
 * checkbox page.
 */
export const TERMS_VERSION = '2026-09-16'

/**
 * The checkbox label as HTML: "Terms of Service" and "Privacy Policy" are
 * the links. Static text (nothing interpolated), so it is safe to inject.
 */
export const TERMS_CHECKBOX_LABEL_HTML =
  `I agree to AgentMade's <a href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">Terms of Service</a>, ` +
  `<a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and arbitration provision`

/**
 * Which button started a sign-in: "Sign up" or "Sign in". The auth worker
 * uses it only to word its fallback page when a "Sign in" finds no account.
 */
export type SignInIntent = 'signup' | 'signin'

/**
 * What a sign-in click tells the host, on both the `oc-signin-gesture` window
 * message and the `kernel.signIn` params. Both fields are optional.
 *
 * `acceptedTerms` is the {@link TERMS_VERSION} whose checkbox the user ticked
 * in the app before Google opened. The host forwards these fields only for
 * the platform's own app, and the auth worker honours `acceptedTerms` only
 * when the sign-in returns to an app whose project holds the platform's own
 * grant; anywhere else a sign-up still gets the worker's checkbox page.
 */
export interface SignInHint {
  intent?: SignInIntent
  acceptedTerms?: string
}

/** Shape of a Terms version token on the wire: a short date-like id. */
const TERMS_TOKEN_RE = /^[0-9A-Za-z-]{1,32}$/

export function isSignInIntent(value: unknown): value is SignInIntent {
  return value === 'signup' || value === 'signin'
}

/** True for a string shaped like a Terms version. Says nothing about which one. */
export function isTermsToken(value: unknown): value is string {
  return typeof value === 'string' && TERMS_TOKEN_RE.test(value)
}

/**
 * Keep the well-formed fields of an untrusted {@link SignInHint} and drop the
 * rest. A dropped field means the server asks as if it was never sent.
 */
export function parseSignInHint(raw: unknown): SignInHint {
  if (typeof raw !== 'object' || raw === null) return {}
  const { intent, acceptedTerms } = raw as Record<string, unknown>
  return {
    ...(isSignInIntent(intent) ? { intent } : {}),
    ...(isTermsToken(acceptedTerms) ? { acceptedTerms } : {}),
  }
}
