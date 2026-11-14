import { NextResponse } from "next/server";
import { agentSecret, verifyCallback } from "@/lib/runs/callback-auth";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { checkExternalGate, signGateResponse } from "@/lib/runs/external-gate";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

/**
 * Gate-first endpoint for external routines. Headers: x-agent-key (claude-sonnet|claude-opus|codex|gpt),
 * x-timestamp, x-event-id (unique per check), x-signature = HMAC-SHA256(RUN_CALLBACK_SECRET_<PROVIDER>, `${ts}.${eventId}.`).
 * Secret provider = first segment of the key (claude, codex, gpt). Any failure => do NOT run.
 */
async function handle(req: Request): Promise<NextResponse> {
  const key = (req.headers.get("x-agent-key") ?? "").toLowerCase();
  const secret = agentSecret(key.split("-")[0]);
  const eventId = req.headers.get("x-event-id");
  const auth = verifyCallback({ secret, timestamp: req.headers.get("x-timestamp"), eventId, signature: req.headers.get("x-signature"), rawBody: "", nowMs: Date.now() });
  if (!auth.ok) return NextResponse.json({ allow: false, error: "unauthorized" }, { status: auth.reason === "missing_secret" ? 503 : 401, headers: H });
  try {
    const r = await checkExternalGate(getRunStore(), key, eventId!, new Date().toISOString());
    if (!r.ok) return NextResponse.json({ allow: false, error: r.reason }, { status: r.reason === "replay" ? 409 : 400, headers: H });
    const body = JSON.stringify({ allow: r.allow, reason: r.reason, agent: r.agent, at: r.at, eventId: r.eventId });
    return new NextResponse(body, { status: 200, headers: { ...H, "Content-Type": "application/json", "x-signature": signGateResponse(secret!, r.at, r.eventId, body) } });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return NextResponse.json({ allow: false, error: cfg ? "store_unconfigured" : "store_error" }, { status: cfg ? 503 : 500, headers: H });
  }
}
export const GET = handle;
export const POST = handle;
