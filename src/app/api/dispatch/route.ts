import { NextResponse } from "next/server";
import { authorize } from "@/lib/session/guard";
import { getRunStore, RunStoreConfigurationError } from "@/lib/runs/store";
import { GitHubLabelAdapter, dispatchIssue, submitQueued } from "@/lib/runs/dispatcher";
import { isAgentKey } from "@/lib/control/model";

export const dynamic = "force-dynamic";
const H = { "Cache-Control": "no-store" };

/** Admin-only. Body: {issueNumber, agent} (new dispatch) or {dispatchId} (release a held record). Gate runs server-side immediately before submission. */
export async function POST(req: Request): Promise<Response> {
  const auth = authorize(req.method, req.headers, "admin");
  if (!auth.ok) return NextResponse.json({ error: auth.status === 503 ? "control_unconfigured" : "unauthorized" }, { status: auth.status, headers: H });
  const raw = await req.text();
  let b: Record<string, unknown>;
  try { b = raw.length > 4096 ? {} : JSON.parse(raw); } catch { b = {}; }
  const token = process.env.GITHUB_TOKEN?.trim(), repo = process.env.GITHUB_REPO?.trim();
  if (!token || !repo) return NextResponse.json({ error: "github_unconfigured" }, { status: 503, headers: H });
  const adapter = new GitHubLabelAdapter({ token, repo });
  const now = new Date().toISOString();
  try {
    const store = getRunStore();
    const r = typeof b.dispatchId === "string"
      ? await submitQueued(store, adapter, b.dispatchId, now)
      : Number.isInteger(b.issueNumber) && (b.issueNumber as number) > 0 && isAgentKey(b.agent)
        ? await dispatchIssue(store, adapter, b.issueNumber as number, b.agent, now)
        : null;
    if (!r) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: H });
    return NextResponse.json(r.ok ? { ok: true, dispatchId: r.record.dispatchId, status: r.record.status, submission: r.record.submission ?? null } : { ok: false, stage: r.stage, reason: r.reason }, { status: r.ok ? 200 : 409, headers: H });
  } catch (e) {
    const cfg = e instanceof RunStoreConfigurationError;
    return NextResponse.json({ error: cfg ? "store_unconfigured" : "store_error" }, { status: cfg ? 503 : 500, headers: H });
  }
}
