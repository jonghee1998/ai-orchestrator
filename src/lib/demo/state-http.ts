// GET/POST /api/demo — 공개(비밀 없음): 데모 상태/시나리오. POST 는 시나리오 쿠키(비민감)만 설정한다.
import { demoState, parseScenario, SCENARIOS, SCENARIO_COOKIE, type Env } from "./mode";
import { demoDecision } from "./gate";

export function handleDemoState(method: string, h: Headers, raw: string, env: Env): { status: number; body: unknown; setCookie?: string } {
  const s = demoState(env);
  if (s.mode === "off") return { status: 200, body: { demo: false } };
  if (s.mode === "blocked") return { status: 503, body: { demo: "blocked", reason: s.reason } };
  if (method === "POST") {
    const origin = h.get("origin");
    try { if (origin && new URL(origin).host !== (h.get("x-forwarded-host") ?? h.get("host"))) return { status: 403, body: { error: "csrf" } }; } catch { return { status: 403, body: { error: "csrf" } }; }
    let sc = "normal"; try { sc = String(JSON.parse(raw)?.scenario ?? "normal"); } catch { /* 기본값 */ }
    const scenario = parseScenario(sc);
    return { status: 200, body: { demo: true, scenario, scenarios: SCENARIOS }, setCookie: `${SCENARIO_COOKIE}=${scenario}; Path=/; SameSite=Lax; Max-Age=86400${env.NODE_ENV === "production" ? "; Secure" : ""}` };
  }
  const d = demoDecision(h, env);
  return { status: 200, body: { demo: true, scenario: d.demo === true ? d.scenario : "normal", scenarios: SCENARIOS } };
}
