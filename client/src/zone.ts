// Zone resolution: derive the platform zone (last two DNS labels) from a
// hostname so any Mythwork app can locate auth/api without hard-coding zones.
//
// Three near-identical copies existed in myth-ide, myth-landing, and
// myth-explore (explore's copy lived at src/platform/zone.ts with a comment
// noting no shared package existed). This canonical copy ends that drift.

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

/** Resolve the platform zone from a hostname: the last two dot-labels
 * (`explore.llama.space` → `llama.space`). `localhost`, any IPv4 literal
 * (127.0.0.1, LAN IPs like 192.168.x.x used for phone testing), and
 * single-label hosts fall back to the production zone `myth.work`. Defaults
 * to the live `window.location.hostname`. */
export function zoneHost(hostname?: string): string {
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '')
  const labels = host.split('.')
  if (host === 'localhost' || IPV4_LITERAL.test(host) || labels.length < 2) {
    return 'myth.work'
  }
  return labels.slice(-2).join('.')
}
