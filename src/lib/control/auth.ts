// Admin auth for control mutations. Fail closed: no CONTROL_ADMIN_TOKEN configured => mutations disabled (503).
import { createHash, timingSafeEqual } from "node:crypto";

export type AdminAuth = { ok: true } | { ok: false; status: 401 | 503 };
export function checkAdmin(header: string | null, env: Readonly<Record<string, string | undefined>> = process.env): AdminAuth {
  const want = env.CONTROL_ADMIN_TOKEN;
  if (!want || want.length < 16) return { ok: false, status: 503 };
  const h = (x: string) => createHash("sha256").update(x).digest();
  return header && timingSafeEqual(h(header), h(want)) ? { ok: true } : { ok: false, status: 401 };
}
