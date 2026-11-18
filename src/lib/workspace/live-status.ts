// Issue #161 (T6): honest live status per project, derived ONLY from the existing read-only ModelProject
// (actual GitHub evidence). No new runtime, no percentages, nothing inferred beyond phase/history labels.
// Self-reported PASS/approval is labelled as such; it never authorizes execution/merge/deploy.
import type { ModelProject, ModelTask } from "./model";

export type Verdict = "pass" | "fail" | "blocked" | "approval_needed" | "none";
export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: "검수 통과 보고 (자기보고 · 승인·배포 아님)", fail: "수정 요청됨", blocked: "도움 필요 · 진행 막힘", approval_needed: "사용자 검수·결정 필요", none: "확인된 검수 결과 없음",
};
export interface LiveStatus {
  goal: string;
  doneCount: number; currentCount: number; remainingCount: number; unknownCount: number;
  current: { id: string; title: string; agentName: string; stage: string }[];
  verdict: Verdict; verdictLabel: string;
  summary: string;
}
const isCurrent = (t: ModelTask) => t.phase === "active" || t.phase === "reported" || t.phase === "review" || t.phase === "blocked";

/** Verdict priority: a blocked/needs-decision task is current truth; otherwise the newest history signal; otherwise none. */
export function latestVerdict(p: Pick<ModelProject, "tasks" | "history">): Verdict {
  if (p.tasks.some(t => t.phase === "blocked")) return "blocked";
  if (p.tasks.some(t => t.phase === "review")) return "approval_needed";
  // Filter to verdict-bearing events BEFORE picking the latest: a newer ACK / dev-complete / runtime start-finish
  // event must not erase an earlier confirmed FAIL/PASS.
  const kind = (c: string): Verdict | null => c.includes("수정 요청") ? "fail" : c.includes("검수 통과") ? "pass" : null;
  const newest = [...p.history].filter(h => kind(h.change)).sort((a, b) => b.at.localeCompare(a.at))[0];
  return newest ? kind(newest.change)! : "none";
}

export function liveStatus(p: ModelProject): LiveStatus {
  const current = p.tasks.filter(isCurrent).map(t => ({ id: t.id, title: t.title, agentName: t.agentName, stage: t.phaseLabel }));
  const verdict = latestVerdict(p);
  const goal = p.goal ?? "목표 미확인";
  const { completed, remaining, active, unknown } = p.counts;
  const summary = p.counts.total === 0 ? "확인된 업무가 없습니다."
    : `완료 ${completed}건, 진행 ${active}건, 남은 ${remaining}건${p.counts.reported ? `, 접수 보고 ${p.counts.reported}건(실행 미확인)` : ""}${unknown ? `, 확인 불가 ${unknown}건` : ""}. ${VERDICT_LABEL[verdict]}.`;
  return { goal, doneCount: completed, currentCount: current.length, remainingCount: remaining, unknownCount: unknown, current, verdict, verdictLabel: VERDICT_LABEL[verdict], summary };
}
