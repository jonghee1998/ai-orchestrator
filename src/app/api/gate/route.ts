import { NextResponse } from "next/server";
import { getRunStore } from "@/lib/runs/store";
import { handleGate } from "@/lib/runs/gate-http";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store", "Content-Type": "application/json" };

/** Gate v2 (#34) for external routines — see src/lib/runs/gate-http.ts and docs/LIVE_INTEGRATION.md §3. POST only. */
export async function POST(req: Request): Promise<NextResponse> {
  const r = await handleGate(req.headers, await req.text(), () => getRunStore(), process.env, Date.now());
  return new NextResponse(r.body, { status: r.status, headers: r.signature ? { ...H, "x-signature": r.signature } : H });
}
/** v1 GET (empty signed body) is retired: it bound neither agent nor task. Fail closed. */
export function GET(): NextResponse {
  return NextResponse.json({ allow: false, error: "method_not_allowed" }, { status: 405, headers: { "Cache-Control": "no-store", Allow: "POST" } });
}
