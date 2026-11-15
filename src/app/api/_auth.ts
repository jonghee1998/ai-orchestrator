import { NextResponse } from "next/server";
import { checkRead } from "@/lib/control/auth";
export const NOSTORE = { "Cache-Control": "no-store" };
/** Returns an error response if the request lacks a valid read/admin token. */
export function requireRead(req: Request): NextResponse | null {
  const a = checkRead(req.headers.get("x-admin-token"));
  return a.ok ? null : NextResponse.json({ error: a.status === 503 ? "auth_unconfigured" : "unauthorized", reason: a.reason }, { status: a.status, headers: NOSTORE });
}
