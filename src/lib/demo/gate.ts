// API 라우트용 데모 게이트 (#85). 인증(requireRead/authorize) 통과 후에 호출한다.
import { demoState, parseScenario, SCENARIO_COOKIE, type Env, type Scenario } from "./mode";

export type DemoDecision =
  | { demo: false }
  | { demo: true; scenario: Scenario }
  | { demo: "blocked"; reason: string };

function cookieOf(h: Headers, name: string): string | null {
  for (const p of (h.get("cookie") ?? "").split(";")) { const i = p.indexOf("="); if (i > 0 && p.slice(0, i).trim() === name) return p.slice(i + 1).trim(); }
  return null;
}
export function demoDecision(h: Headers, env: Env = process.env): DemoDecision {
  const s = demoState(env);
  if (s.mode === "off") return { demo: false };
  if (s.mode === "blocked") return { demo: "blocked", reason: s.reason };
  return { demo: true, scenario: parseScenario(cookieOf(h, SCENARIO_COOKIE)) };
}
/** 데모 ON: 변경 요청은 항상 거부. 차단 상태: 모든 요청 거부. 응답 Response 또는 null(진행 가능, 데모 아님). */
export function demoBlockResponse(d: DemoDecision, mutation: boolean): Response | null {
  const H = { "Cache-Control": "no-store", "Content-Type": "application/json" };
  if (d.demo === "blocked") return new Response(JSON.stringify({ error: "demo_misconfigured", reason: d.reason }), { status: 503, headers: H });
  if (d.demo === true && mutation) return new Response(JSON.stringify({ error: "demo_read_only" }), { status: 403, headers: H });
  return null;
}
