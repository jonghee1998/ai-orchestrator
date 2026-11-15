// Admin/read auth. Fail closed: no token configured => endpoint disabled (503).
import { createHash, timingSafeEqual } from "node:crypto";

export type AuthReason = "not_configured" | "token_missing" | "mismatch";
export type AdminAuth = { ok: true } | { ok: false; status: 401 | 503; reason?: AuthReason };
type Env = Readonly<Record<string, string | undefined>>;
const h = (x: string) => createHash("sha256").update(x).digest();
/**
 * Normalize a token from either side (client input or server env): strip BOM/zero-width chars,
 * surrounding whitespace/CR/LF, and one pair of matching surrounding quotes (common copy/paste and
 * Vercel env artifacts). Never weakens auth: interior characters are untouched and comparison stays exact.
 */
export function normalizeToken(v: string | null | undefined): string {
  let t = (v ?? "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) t = t.slice(1, -1).trim();
  return t;
}
const same = (a: string, b: string) => timingSafeEqual(h(a), h(b));

export function checkAdmin(header: string | null, env: Env = process.env): AdminAuth {
  const want = normalizeToken(env.CONTROL_ADMIN_TOKEN);
  if (want.length < 16) return { ok: false, status: 503, reason: "not_configured" };
  const got = normalizeToken(header);
  if (!got) return { ok: false, status: 401, reason: "token_missing" };
  return same(got, want) ? { ok: true } : { ok: false, status: 401, reason: "mismatch" };
}

/** Read endpoints: accept CONTROL_READ_TOKEN or the admin token. No token configured at all => 503. */
export function checkRead(header: string | null, env: Env = process.env): AdminAuth {
  const toks = [env.CONTROL_READ_TOKEN, env.CONTROL_ADMIN_TOKEN].map(normalizeToken).filter((t) => t.length >= 16);
  if (toks.length === 0) return { ok: false, status: 503, reason: "not_configured" };
  const got = normalizeToken(header);
  if (!got) return { ok: false, status: 401, reason: "token_missing" };
  return toks.some((t) => same(got, t)) ? { ok: true } : { ok: false, status: 401, reason: "mismatch" };
}

/** Cron/scheduler auth for GET /api/reconcile: `Authorization: Bearer <CRON_SECRET>` (Vercel Cron format) or the admin token. */
export function checkCron(authorization: string | null, adminHeader: string | null, env: Env = process.env): AdminAuth {
  const cronRaw = normalizeToken(env.CRON_SECRET);
  const cron = cronRaw.length >= 16 ? cronRaw : undefined;
  const admin = checkAdmin(adminHeader, env);
  if (!cron && !admin.ok && admin.status === 503) return { ok: false, status: 503 };
  const bearer = authorization?.startsWith("Bearer ") ? normalizeToken(authorization.slice(7)) : null;
  if (cron && bearer && same(bearer, cron)) return { ok: true };
  return admin.ok ? { ok: true } : { ok: false, status: 401 };
}
