import { NextResponse } from "next/server";
import { requireRead } from "../_auth";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { displayStatus, latencies } from "@/lib/runs/run-tracking";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

export async function GET(req: Request): Promise<NextResponse> {
  const denied = requireRead(req);
  if (denied) return denied;
  try {
    const { records } = await getRunStore().read();
    const runs = Object.values(records).map((r) => ({
      dispatchId: r.dispatchId, issueNumber: r.issueNumber, agent: r.agent, attempt: r.attempt,
      status: displayStatus(r), verified: r.source === "agent-callback", submission: r.submission ?? null,
      lastActivityAt: r.lastActivityAt ?? r.lastHeartbeatAt ?? r.dispatchedAt ?? r.requestedAt,
      lastError: r.lastError ?? null, evidence: r.evidence, latency: latencies(r),
      collaboration: r.collaboration ?? null, execution: r.execution ?? null,
    }));
    return NextResponse.json({ mode: "live", runs }, { headers: H });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return NextResponse.json({ mode: cfg ? "unconfigured" : "error", runs: [] }, { status: cfg ? 200 : 500, headers: H });
  }
}
