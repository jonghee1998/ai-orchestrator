import { demoDecision } from "./gate";
import { demoRead, type DemoKind } from "./respond";

/** 인증 통과 후 호출. 데모면 합성 응답 Response, 아니면 null (실제 경로 진행). */
export function demoReadResponse(req: Request, kind: DemoKind): Response | null {
  const d = demoDecision(req.headers);
  if (d.demo !== true) return null;
  const r = demoRead(kind, d.scenario);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Demo": "1" } });
}
