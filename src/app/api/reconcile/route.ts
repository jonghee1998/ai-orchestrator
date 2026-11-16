import { NextResponse } from "next/server";
import { handleReconcile, type ReconcileReply } from "@/lib/control/reconcile-http";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { reconcile } from "@/lib/runs/service";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

/** GET: explicit cron/admin credentials only. POST: admin token or session + CSRF. */
async function handle(req: Request): Promise<NextResponse> {
  const r = await handleReconcile(req.method, req.headers, process.env, Date.now(), run);
  return NextResponse.json(r.body, { status: r.status, headers: H });
}
export const GET = handle;
export const POST = handle;

async function run(): Promise<ReconcileReply> {
  try {
    return { status: 200, body: { ok: true, changed: await reconcile(getRunStore(), new Date().toISOString()) } };
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return { status: cfg ? 503 : 500, body: { error: cfg ? "store_unconfigured" : "store_error" } };
  }
}
