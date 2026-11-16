// 데모 모드 읽기 응답 (#85). 네트워크/DB/프로바이더 호출 없음. 시나리오로 성공/부분 실패/오류/빈 상태를 모사한다.
import { demoDashboard, demoEvidence, demoQueue, demoReadiness, demoRuns } from "./fixtures";
import type { Scenario } from "./mode";

export type DemoKind = "dashboard" | "readiness" | "runs" | "work-queue" | "evidence" | "collaboration";
const PARTIAL_FAIL: DemoKind[] = ["readiness", "work-queue", "evidence"]; // 부분 실패: 대시보드/실행은 성공, 나머지는 mock 502
export function demoRead(kind: DemoKind, scenario: Scenario): { status: number; body: unknown } {
  if (scenario === "error" || (scenario === "partial-failure" && PARTIAL_FAIL.includes(kind))) {
    const status = scenario === "error" ? 500 : 502;
    return { status, body: kind === "work-queue" ? { mode: "error", tasks: [], error: "데모: 모사된 실패" } : kind === "runs" ? { mode: "error", runs: [] } : kind === "evidence" ? { mode: "error", error: "demo_simulated_failure" } : { mode: "error", category: "demo_simulated" } };
  }
  switch (kind) {
    case "dashboard": return { status: 200, body: demoDashboard(scenario) };
    case "readiness": return { status: 200, body: demoReadiness() };
    case "runs": return { status: 200, body: { mode: "live", runs: demoRuns(scenario) } };
    case "work-queue": return { status: 200, body: { mode: "live", tasks: demoQueue(scenario) } };
    case "evidence": return { status: 200, body: { mode: "live", report: demoEvidence(scenario) } };
    case "collaboration": return { status: 200, body: { workflows: [] } };
  }
}
