// Admin/read auth. Fail closed: no token configured => endpoint disabled (503).
import { createHash, timingSafeEqual } from "node:crypto";

export type AdminAuth = { ok: true } | { ok: false; status: 401 | 503 };
type Env = Readonly<Record<string, string | undefined>>;
const h = (x: string) => createHash("sha256").update(x).digest();
const same = (a: string, b: string) => timingSafeEqual(h(a), h(b));

export function checkAdmin(header: string | null, env: Env = process.env): AdminAuth {
  const want = env.CONTROL_ADMIN_TOKEN;
  if (!want || want.length < 16) return { ok: false, status: 503 };
  return header && same(header, want) ? { ok: true } : { ok: false, status: 401 };
}

/** Read endpoints: accept CONTROL_READ_TOKEN or the admin token. No token configured at all => 503. */
export function checkRead(header: string | null, env: Env = process.env): AdminAuth {
  const toks = [env.CONTROL_READ_TOKEN, env.CONTROL_ADMIN_TOKEN].filter((t): t is string => !!t && t.length >= 16);
  if (toks.length === 0) return { ok: false, status: 503 };
  return header && toks.some((t) => same(header, t)) ? { ok: true } : { ok: false, status: 401 };
}
