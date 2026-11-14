import { NextResponse } from "next/server";
import { requireRead } from "../_auth";
import { computeReadiness } from "@/lib/readiness";

export const dynamic = "force-dynamic";
/** Authenticated; reports configuration presence only (never values). */
export async function GET(req: Request): Promise<NextResponse> {
  const denied = requireRead(req);
  if (denied) return denied;
  return NextResponse.json(computeReadiness(process.env), { headers: { "Cache-Control": "no-store" } });
}
