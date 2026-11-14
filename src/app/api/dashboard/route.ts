import { NextResponse } from "next/server";
import { requireRead } from "../_auth";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { buildSnapshot } from "@/lib/control/service";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

/** Monitoring: reads the durable store only. Makes NO provider calls, so disabled agents are never invoked. */
export async function GET(req: Request): Promise<NextResponse> {
  const denied = requireRead(req);
  if (denied) return denied;
  try {
    const d = await getRunStore().read();
    return NextResponse.json(buildSnapshot(d, new Date().toISOString()), { headers: H });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return NextResponse.json({ mode: cfg ? "unconfigured" : "error" }, { status: cfg ? 200 : 500, headers: H });
  }
}
