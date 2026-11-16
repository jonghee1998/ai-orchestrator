import { NextResponse } from "next/server";
import { demoReadResponse } from "@/lib/demo/respond-http";
import { requireRead } from "../_auth";
import { computeReadiness, githubEvidenceReadiness } from "@/lib/readiness";
import { getRunStore } from "@/lib/runs/store";
import { probeGitHub } from "@/lib/github/integration";
import { classifyStoreError } from "@/lib/runs/store-errors";

export const dynamic = "force-dynamic";
/** Authenticated; reports configuration presence only (never values). */
export async function GET(req: Request): Promise<NextResponse> {
  const denied = requireRead(req);
  if (denied) return denied;
  const demo = demoReadResponse(req, "readiness");
  if (demo) return demo as NextResponse;
  const r = computeReadiness(process.env);
  // Real connectivity probe (read-only store read). Reports a category only, never messages or values.
  if (process.env.DATABASE_URL) {
    const db = r.items.find((i) => i.id === "database");
    try { await getRunStore().read(); if (db) { db.state = "ok"; db.detail = "설정됨 · 연결/읽기 확인됨"; } }
    catch (e) { const category = classifyStoreError(e); console.error(`[api/readiness] db probe failed category=${category}`); if (db) { db.state = "blocked"; db.detail = `연결 실패 (category: ${category})`; } }
  }
  // Real read-only GitHub probe (GET repo + GET repo/issues; #67: + the PR/comment/review/commit reads /api/evidence needs). Reports configured/live/error, never values.
  const gh = await probeGitHub(process.env);
  const item = r.items.find((i) => i.id === "github");
  if (item) {
    const src = gh.tokenSource === "shared" ? " · GITHUB_READ_TOKEN 미설정: 쓰기 가능 토큰으로 읽는 중(최소권한 미충족)" : "";
    if (gh.state === "live") { item.state = "ok"; item.detail = `live · ${gh.repo} + Issues 읽기 확인됨(열린 이슈 ${gh.openIssues ?? "unknown"})${src} · 읽기전용 여부: ${gh.readOnly === "unknown" ? "unknown(검증 불가)" : "쓰기 scope 헤더 없음"}`; }
    else if (gh.state === "error") { item.state = "blocked"; item.detail = `연결 실패 (${gh.error}${gh.issues === "denied" ? " · 토큰에 Issues 읽기 권한 없음" : gh.issues === "disabled" ? " · 저장소 Issues 비활성화" : ""})`; }
    else { item.state = "missing"; item.detail = "미설정 (GITHUB_REPO + GITHUB_READ_TOKEN 또는 GITHUB_TOKEN)"; }
  }
  return NextResponse.json({ ...r, github: gh, githubEvidence: githubEvidenceReadiness(r.items, gh) }, { headers: { "Cache-Control": "no-store" } });
}
