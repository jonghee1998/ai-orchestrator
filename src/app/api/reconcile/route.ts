import { NextResponse } from "next/server";
import { checkAdmin } from "@/lib/control/auth";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { reconcile } from "@/lib/runs/service";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

/** Admin-only; call from an external scheduler (cron) and after restarts. Makes no provider calls and never resubmits. */
export async function POST(req: Request): Promise<NextResponse> {
  const auth = checkAdmin(req.headers.get("x-admin-token"));
  if (!auth.ok) return NextResponse.json({ error: auth.status === 503 ? "control_unconfigured" : "unauthorized" }, { status: auth.status, headers: H });
  try {
    return NextResponse.json({ ok: true, changed: await reconcile(getRunStore(), new Date().toISOString()) }, { headers: H });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return NextResponse.json({ error: cfg ? "store_unconfigured" : "store_error" }, { status: cfg ? 503 : 500, headers: H });
  }
}
