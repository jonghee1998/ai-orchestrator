import { NextResponse } from "next/server";
import { authorize } from "@/lib/session/guard";
export const NOSTORE = { "Cache-Control": "no-store" };
/** Returns an error response if the request lacks a valid read/admin token. */
export function requireRead(req: Request): NextResponse | null {
  const a = authorize(req.method, req.headers, "read");
  return a.ok ? null : NextResponse.json({ error: a.status === 503 ? "auth_unconfigured" : "unauthorized", reason: a.reason }, { status: a.status, headers: NOSTORE });
}
