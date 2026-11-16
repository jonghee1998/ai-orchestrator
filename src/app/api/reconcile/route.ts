import { NextResponse } from "next/server";
import { checkCron } from "@/lib/control/auth";
import { authorize } from "@/lib/session/guard";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { reconcile } from "@/lib/runs/service";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

/** Vercel Cron entry point (GET + CRON_SECRET bearer, or admin token). Same no-provider-call reconcile. */
export async function GET(req: Request): Promise<NextResponse> {
  const cron = checkCron(req.headers.get("authorization"), req.headers.get("x-admin-token"));
  const auth = cron.ok || req.headers.get("x-admin-token") !== null ? cron : authorize("GET", req.headers, "admin");
  if (!auth.ok) return NextResponse.json({ error: auth.status === 503 ? "control_unconfigured" : "unauthorized" }, { status: auth.status, headers: H });
  return run();
}

/** Admin-only; call from an external scheduler (cron) and after restarts. Makes no provider calls and never resubmits. */
export async function POST(req: Request): Promise<NextResponse> {
  const auth = authorize(req.method, req.headers, "admin");
  if (!auth.ok) return NextResponse.json({ error: auth.status === 503 ? "control_unconfigured" : "unauthorized" }, { status: auth.status, headers: H });
  return run();
}

async function run(): Promise<NextResponse> {
  try {
    return NextResponse.json({ ok: true, changed: await reconcile(getRunStore(), new Date().toISOString()) }, { headers: H });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return NextResponse.json({ error: cfg ? "store_unconfigured" : "store_error" }, { status: cfg ? 503 : 500, headers: H });
  }
}
