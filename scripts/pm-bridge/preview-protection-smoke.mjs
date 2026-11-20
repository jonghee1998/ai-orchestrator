// Read-only Preview protection smoke check. No credentials, redirects, or mutations.
const HOST = /^[a-z0-9][a-z0-9.-]*\.vercel\.app$/;
export function validatePreviewUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("invalid_url"); }
  if (u.protocol !== "https:" || !HOST.test(u.hostname) || u.port ||
      u.username || u.password || u.search || u.hash ||
      (u.pathname !== "/" && u.pathname !== "")) throw new Error("invalid_preview_origin");
  return u.href;
}
export function classifyProtection(status, location) {
  if (status === 401 || status === 403) return { ok: false, reason: "access_denied_origin_unverified" };
  if ([301, 302, 303, 307, 308].includes(status)) {
    let u;
    try { u = new URL(location); } catch { return { ok: false, reason: "unknown_redirect" }; }
    if (u.protocol === "https:" &&
        (u.hostname === "vercel.com" || u.hostname.endsWith(".vercel.com")) &&
        u.pathname.split("/").some(segment => ["auth", "login", "sso"].includes(segment.toLowerCase())))
      return { ok: true, basis: "vercel_auth_redirect" };
    return { ok: false, reason: "unverified_redirect" };
  }
  return { ok: false, reason: status === 200 ? "publicly_accessible" : "unexpected_status" };
}
export async function auditPreview(raw, request = fetch) {
  const url = validatePreviewUrl(raw);
  let res;
  try {
    res = await request(url, { method: "GET", redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(8000), headers: { accept: "text/html" } });
  } catch { return { ok: false, reason: "network_unknown" }; }
  return classifyProtection(res.status, res.headers.get("location"));
}
if (process.argv[1]?.endsWith("/preview-protection-smoke.mjs")) {
  const url = process.env.PREVIEW_ORIGIN;
  if (!url) { process.stderr.write("PREVIEW_ORIGIN required\n"); process.exitCode = 2; }
  else auditPreview(url).then(r => {
    process.stdout.write(JSON.stringify(r) + "\n");
    if (!r.ok) process.exitCode = 1;
  }).catch(() => { process.stderr.write("invalid preview origin\n"); process.exitCode = 2; });
}
