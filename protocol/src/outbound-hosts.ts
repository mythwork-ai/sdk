/**
 * Reviewed destination table for `nav.openExternal`.
 *
 * Deliberately a code constant rather than a table: widening where hosted
 * apps can send a visitor is a decision that should leave a diff and pass
 * review, not a `wrangler d1 execute`. Enforcement runs ONLY in the host
 * frame — the sandboxed app frame cannot be trusted to classify its own
 * destinations. It lives here (rather than in host-iframe) so the SDK dev
 * host classifies with the same table and an app developer sees the same
 * warn/never behavior locally that production will apply.
 *
 * Everything unlisted is 'warn', so this table only needs the two ends: the
 * destinations frequent enough that a dialog would be noise, and the ones we
 * refuse outright.
 */

export type OutboundLevel = 'always' | 'warn' | 'never'

/**
 * Matched as registrable-domain suffixes, so `explore.myth.work` is covered
 * by `myth.work`. Both platform zones are here because warning a visitor
 * about a link back to the platform that served the page reads as a bug.
 * Nothing third-party qualifies: the bar is no attacker-creatable content
 * and no open redirector anywhere under the suffix — google.com failed both
 * (docs.google.com/forms is an attacker-creatable receiver,
 * www.google.com/url redirects anywhere) and was removed.
 */
const ALWAYS: readonly string[] = ['myth.work', 'llama.space']

/**
 * Seeded from the StevenBlack hosts list. Only entries that list the bare
 * registrable domain there are included — `facebook.com`, for instance,
 * appears only as `an.` / `pixel.` subdomains, and blocking the apex on that
 * basis would be wrong.
 */
const NEVER: readonly string[] = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'amazon-adsystem.com',
  'criteo.com',
  'openx.net',
  'taboola.com',
  'outbrain.com',
  'scorecardresearch.com',
]

function matchLength(hostname: string, entries: readonly string[]): number {
  let best = 0
  for (const entry of entries) {
    if (hostname !== entry && !hostname.endsWith('.' + entry)) continue
    if (entry.length > best) best = entry.length
  }
  return best
}

function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return h === 'localhost' || h === '127.0.0.1' || h.endsWith('.localhost')
}

/**
 * The local stack serves published apps at `http://{alias}.localhost:<port>`,
 * which the https-only enforcement would silently drop. A page itself on a
 * local hostname linking to another local hostname is the dev stack standing
 * in for the platform zone, so it opens the way the zone does in production:
 * http allowed, no dialog. Production pages never run on a local hostname.
 */
export function isLocalOutbound(pageHostname: string, url: URL): boolean {
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    isLocalHostname(pageHostname) &&
    isLocalHostname(url.hostname)
  )
}

/**
 * Longest match wins so a specific `never` entry can carve an exception out
 * of a broader `always` one; `never` also wins an exact-length tie.
 */
export function classifyOutboundHost(hostname: string): OutboundLevel {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  const never = matchLength(h, NEVER)
  const always = matchLength(h, ALWAYS)
  if (never > 0 && never >= always) return 'never'
  if (always > 0) return 'always'
  return 'warn'
}
