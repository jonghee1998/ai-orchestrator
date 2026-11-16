import { demoBlockResponse, demoDecision } from "./gate";
import type { Env } from "./mode";
import { demoRead, type DemoKind } from "./respond";

/** Recheck in Node runtime, where all environment variables are available. */
export function demoRequestBlock(req: Request, env: Env = process.env): Response | null {
  const mutation = !["GET", "HEAD"].includes(req.method) || new URL(req.url).pathname === "/api/reconcile";
  return demoBlockResponse(demoDecision(req.headers, env), mutation);
}

/** 인증 통과 후 호출. 데모면 합성 응답 Response, 아니면 null (실제 경로 진행). */
export function demoReadResponse(req: Request, kind: DemoKind, env: Env = process.env): Response | null {
  const blocked = demoRequestBlock(req, env);
  if (blocked) return blocked;
  const d = demoDecision(req.headers, env);
  if (d.demo !== true) return null;
  const r = demoRead(kind, d.scenario);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Demo": "1" } });
}
