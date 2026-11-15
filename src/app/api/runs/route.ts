import { NextResponse } from "next/server";
import { requireRead } from "../_auth";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { runView } from "@/lib/runs/run-trust";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

export async function GET(req: Request): Promise<NextResponse> {
  const denied = requireRead(req);
  if (denied) return denied;
  try {
    const { records } = await getRunStore().read();
    // #57: `verified`/`origin`/`trust` come from run-trust.ts — a session self-report is never "verified".
    const runs = Object.values(records).map(runView);
    return NextResponse.json({ mode: "live", runs }, { headers: H });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return NextResponse.json({ mode: cfg ? "unconfigured" : "error", runs: [] }, { status: cfg ? 200 : 500, headers: H });
  }
}
