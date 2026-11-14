import { NextResponse } from "next/server";
import { agentSecret, verifyCallback } from "@/lib/runs/callback-auth";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { applyCallback } from "@/lib/runs/service";
import type { RunEvent } from "@/lib/runs/run-tracking";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

export async function POST(req: Request): Promise<NextResponse> {
  const rawBody = await req.text();
  if (rawBody.length > 64 * 1024) return NextResponse.json({ error: "too_large" }, { status: 413, headers: H });
  const agent = (req.headers.get("x-agent") ?? "").toLowerCase();
  const auth = verifyCallback({
    secret: agentSecret(agent), timestamp: req.headers.get("x-timestamp"), eventId: req.headers.get("x-event-id"),
    signature: req.headers.get("x-signature"), rawBody, nowMs: Date.now(),
  });
  // Generic 401/503: never reveal which check failed or secret state to callers.
  if (!auth.ok) return NextResponse.json({ error: "unauthorized" }, { status: auth.reason === "missing_secret" ? 503 : 401, headers: H });
  let b: Record<string, unknown>;
  try { b = JSON.parse(rawBody); } catch { return NextResponse.json({ error: "bad_request" }, { status: 400, headers: H }); }
  const at = new Date().toISOString();
  const dispatchId = String(b.dispatchId ?? ""), runId = String(b.runId ?? "");
  const type = b.type;
  if (!dispatchId || !runId || !["ack", "started", "heartbeat", "finished"].includes(String(type)))
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: H });
  const ev = (type === "finished"
    ? { type, at, runId, ok: b.ok === true, error: typeof b.error === "string" ? b.error.slice(0, 500) : undefined }
    : { type, at, runId }) as RunEvent;
  try {
    const r = await applyCallback(getRunStore(), req.headers.get("x-event-id")!, dispatchId, agent, ev, at);
    if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 404, headers: H });
    return NextResponse.json({ ok: true, duplicate: r.duplicate }, { headers: H });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return NextResponse.json({ error: cfg ? "store_unconfigured" : "store_error" }, { status: cfg ? 503 : 500, headers: H });
  }
}
