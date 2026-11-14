import { NextResponse } from "next/server";
import { requireRead } from "../_auth";
import { computeReadiness } from "@/lib/readiness";
import { getRunStore } from "@/lib/runs/store";
import { classifyStoreError } from "@/lib/runs/store-errors";

export const dynamic = "force-dynamic";
/** Authenticated; reports configuration presence only (never values). */
export async function GET(req: Request): Promise<NextResponse> {
  const denied = requireRead(req);
  if (denied) return denied;
  const r = computeReadiness(process.env);
  // Real connectivity probe (read-only store read). Reports a category only, never messages or values.
  if (process.env.DATABASE_URL) {
    const db = r.items.find((i) => i.id === "database");
    try { await getRunStore().read(); if (db) { db.state = "ok"; db.detail = "설정됨 · 연결/읽기 확인됨"; } }
    catch (e) { const category = classifyStoreError(e); console.error(`[api/readiness] db probe failed category=${category}`); if (db) { db.state = "blocked"; db.detail = `연결 실패 (category: ${category})`; } }
  }
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}
