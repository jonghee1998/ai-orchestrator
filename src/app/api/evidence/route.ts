// Issue #60 — protected, read-only GitHub collaboration evidence. Same read/admin token as other live APIs.
import { NextResponse } from "next/server";
import { NOSTORE, requireRead } from "../_auth";
import { EvidenceConfigurationError, EvidenceReadError, readGitHubEvidence } from "@/lib/github/evidence-reader";
import type { EvidenceReport } from "@/lib/github/evidence";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

// Per-instance 30s memo so the 60s UI poll from several tabs does not burn the GitHub rate limit.
let memo: { at: number; key: string; report: EvidenceReport } | undefined;
const TTL_MS = 30_000;

export async function GET(req: Request) {
  const denied = requireRead(req);
  if (denied) return denied;
  const key = `${process.env.GITHUB_REPO ?? ""}`;
  if (memo && memo.key === key && Date.now() - memo.at < TTL_MS) return NextResponse.json({ mode: "live", report: memo.report }, { headers: NOSTORE });
  try {
    const report = await readGitHubEvidence();
    memo = { at: Date.now(), key, report };
    return NextResponse.json({ mode: "live", report }, { headers: NOSTORE });
  } catch (e) {
    if (e instanceof EvidenceConfigurationError) return NextResponse.json({ mode: "unconfigured", error: "github_unconfigured" }, { headers: NOSTORE });
    return NextResponse.json({ mode: "error", error: e instanceof EvidenceReadError ? e.message : "github_evidence_unavailable" }, { status: 502, headers: NOSTORE });
  }
}
