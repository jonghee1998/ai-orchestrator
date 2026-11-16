import { NextResponse } from "next/server";
import { demoReadResponse } from "@/lib/demo/respond-http";
import { requireRead } from "../_auth";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { classifyStoreError } from "@/lib/runs/store-errors";
import { buildSnapshot } from "@/lib/control/service";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

/** Monitoring: reads the durable store only. Makes NO provider calls, so disabled agents are never invoked. */
export async function GET(req: Request): Promise<NextResponse> {
  const denied = requireRead(req);
  if (denied) return denied;
  const demo = demoReadResponse(req, "dashboard");
  if (demo) return demo as NextResponse;
  try {
    const d = await getRunStore().read();
    return NextResponse.json(buildSnapshot(d, new Date().toISOString()), { headers: H });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    const category = classifyStoreError(e);
    console.error(`[api/dashboard] store read failed category=${category}`); // category only: no message/URL/credentials
    return NextResponse.json({ mode: cfg ? "unconfigured" : "error", category }, { status: cfg ? 200 : 500, headers: H });
  }
}
