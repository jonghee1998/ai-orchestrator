// 명시적 서버 측 데모 모드 (#85). DEMO_MODE=1 일 때만 켜지며, 운영 환경에서는 fail-closed 로 모든 데이터 API 를 막는다.
// 데모 모드에서는 실제 GitHub/DB/프로바이더를 호출하지 않고(fixtures.ts 의 결정적 합성 데이터만 응답), 어떤 변경 요청도 수행하지 않는다.
export type Env = Readonly<Record<string, string | undefined>>;
export type DemoState =
  | { mode: "off" }
  | { mode: "on" }
  | { mode: "blocked"; reason: string };

/** 데모 프로젝트에는 있어서는 안 되는 실제 자원/비밀 환경변수. 하나라도 있으면 데모를 켜지 않는다(운영 env 상속 방지). */
export const FORBIDDEN_ENV = [
  "DATABASE_URL", "DATABASE_SSL_CA", "RUN_STORE_PATH", "GITHUB_TOKEN", "GITHUB_READ_TOKEN", "GITHUB_REPO",
  "CRON_SECRET", "GATE_SECRET", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
];
const FORBIDDEN_PREFIX = "RUN_CALLBACK_SECRET_";

export function demoState(env: Env = process.env): DemoState {
  const flag = (env.DEMO_MODE ?? "").trim();
  if (flag === "") return { mode: "off" };
  if (flag !== "1") return { mode: "blocked", reason: "invalid_demo_flag" }; // 모호한 값은 켜지도 끄지도 않고 막는다
  if (env.VERCEL_ENV === "production") return { mode: "blocked", reason: "demo_on_production_deployment" };
  // Vercel 이 아닌 곳(로컬 개발)에서 NODE_ENV=production 이면서 VERCEL_ENV 가 없는 경우도 운영으로 간주하지 않는다 — 단 비밀이 있으면 막는다.
  const leaked = Object.keys(env).filter((k) => (FORBIDDEN_ENV.includes(k) || k.startsWith(FORBIDDEN_PREFIX)) && (env[k] ?? "").trim() !== "");
  if (leaked.length) return { mode: "blocked", reason: "real_resources_configured" };
  return { mode: "on" };
}

export const SCENARIOS = ["normal", "empty", "partial-failure", "error"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const SCENARIO_COOKIE = "demo_scenario";
export const parseScenario = (v: string | null | undefined): Scenario => ((SCENARIOS as readonly string[]).includes(v ?? "") ? (v as Scenario) : "normal");
