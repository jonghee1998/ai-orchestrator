import { NextResponse } from "next/server";
import { getRunStore } from "@/lib/runs/store";
import { handleRunCallback } from "@/lib/runs/callback-http";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

export async function POST(req: Request): Promise<NextResponse> {
  const r = await handleRunCallback(req.headers, await req.text(), getRunStore, process.env, Date.now());
  return new NextResponse(r.body, { status: r.status, headers: { ...H, "Content-Type": "application/json" } });
}
