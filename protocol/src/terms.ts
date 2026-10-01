/**
 * The sign-up Terms checkbox copy, shared by every surface that renders it
 * (the host-frame dialog and the auth worker's /google/callback page) so the
 * wording a user agreed to is one string, not two that drift.
 *
 * Links always point at myth.work — the platform owns the legal documents,
 * so staging and preview zones link there too. The copy is AGE-254's,
 * verbatim.
 */

export const TERMS_URL = 'https://myth.work/terms'
export const PRIVACY_URL = 'https://myth.work/privacy'

/**
 * The checkbox label as HTML: "Terms of Service" and "Privacy Policy" are
 * the links. Static text (nothing interpolated), so it is safe to inject.
 */
export const TERMS_CHECKBOX_LABEL_HTML =
  `I agree to AgentMade's <a href="${TERMS_URL}" target="_blank" rel="noopener noreferrer">Terms of Service</a>, ` +
  `<a href="${PRIVACY_URL}" target="_blank" rel="noopener noreferrer">Privacy Policy</a> and arbitration provision`
