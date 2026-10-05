const BACKEND_ZONE: Readonly<Record<string, string>> = { 'myth.work': 'mythwork.ai' }

/** `auth.` is not here: its cookies only reach a frame same-site with the page. */
export function backendZone(zone: string): string {
  return BACKEND_ZONE[zone] ?? zone
}
