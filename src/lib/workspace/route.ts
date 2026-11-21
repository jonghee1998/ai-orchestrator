// Route-param helpers for real project ids (`label:<name>`, `milestone:<n>`, Unicode). Issue #119.
/** Decode a percent-encoded route param without ever throwing; malformed input is returned unchanged. */
export function safeDecode(v: string): string {
  try { return decodeURIComponent(v); } catch { return v; }
}
/** Find an id for a route param. Next may hand params over raw-encoded or already decoded, so an exact match wins, then the decoded form. */
export function matchRouteId<T extends { id: string }>(items: T[], param: string | undefined): T | undefined {
  if (param === undefined) return undefined;
  return items.find(x => x.id === param) ?? items.find(x => x.id === safeDecode(param));
}
