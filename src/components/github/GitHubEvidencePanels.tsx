"use client";
// Issue #65 — GitHub evidence sections for /progress, /agents, /activity. Rendered SEPARATELY from the internal
// runtime sections: they never change runtime ON/OFF, ACK or completion counters. Non-ok states are explicit
// (no token / 401 / unconfigured / error), so a failed GitHub read is never shown as zero activity.
import { Card } from "@/components/ui";
import { LiveStatus, StaleNotice } from "@/components/live/LiveStatus";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import type { EvidenceReport } from "@/lib/github/evidence";
import {
  GITHUB_STAGE_LABEL, EVENT_KIND_LABEL, absence, atLeast, evidenceCoverage, githubActivity, githubAgents, githubProgress, githubTaskSplit, parseEvidenceResponse, shortenShas, summarizeEvent,
  type EvidenceCoverage, type GitHubAgentRow, type GitHubStage,
} from "@/lib/github/evidence-views";
import { formatKst } from "@/lib/time/kst";

export const GITHUB_POLL_MS = 60_000;
export function useGitHubEvidence() {
  return useAuthedJson<EvidenceReport>("/api/evidence", parseEvidenceResponse, GITHUB_POLL_MS);
}
const when = (iso?: string | null) => formatKst(iso);
const Ext = ({ href, children }: { href?: string; children: React.ReactNode }) =>
  href ? <a href={href} target="_blank" rel="noreferrer" className="break-all text-accent">{children}</a> : <>{children}</>;

/** Heading + provenance line used by every GitHub section. #67: discloses reader truncation (same limits as /evidence). */
function Head({ r, title, stale }: { r: EvidenceReport | null; title: string; stale?: string | null }) {
  const cov = r ? evidenceCoverage(r) : null;
  return (
    <div className="mb-2">
      <h2 className="text-sm font-semibold text-text-muted">{title} <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">GitHub 증거</span></h2>
      <p className="text-[11px] text-text-faint">
        GitHub API 읽기 전용{r ? ` · ${r.repo} · 갱신 ${when(r.generatedAt)}` : ""} · 내부 런타임 기록과 별개 · 에이전트 이름은 코멘트 자기보고(런타임 증명 아님) · {GITHUB_POLL_MS / 1000}초 폴링
      </p>
      <StaleNotice error={stale} />
      {cov?.partial ? (
        <p role="note" aria-label="GitHub 증거 잘림" className="mt-1 rounded bg-warn/15 px-2 py-1 text-[11px] text-warn">
          부분 증거 — {cov.notes.join(" · ")}
        </p>
      ) : null}
    </div>
  );
}
type Ev = ReturnType<typeof useGitHubEvidence>;

const STAGE_TONE: Partial<Record<GitHubStage, string>> = { blocked: "bg-danger/15 text-danger", done: "bg-ok/15 text-ok", review: "bg-accent/15 text-accent", owner_decision: "bg-warn/15 text-warn" };
export function GitHubProgressPanel({ ev }: { ev: Ev }) {
  const r = ev.state.kind === "ok" ? ev.state.data : null;
  if (!r) return <section aria-label="GitHub 진행 증거"><Head r={null} title="GitHub 진행 현황" /><LiveStatus s={ev.state} reload={ev.reload} what="GitHub 증거" /></section>;
  const g = githubProgress(r), cov = evidenceCoverage(r);
  // #67: list by GitHub issue state, not stage — an open issue whose PR merged is stage "done" but still needs closing.
  const open = g.rows.filter((x) => x.issueState === "open");
  return (
    <section aria-label="GitHub 진행 증거">
      <Head r={r} title="GitHub 진행 현황" stale={ev.error} />
      <p className="mb-2 text-xs">이슈 {atLeast(g.total, cov.issuesTruncated)}개 (열림 {atLeast(g.open, cov.issuesTruncated)}){cov.issuesTruncated ? " · 조회 범위 내 집계" : ""} · 완료는 이슈 닫힘/PR 병합 기준(라벨만으로 완료 처리 안 함)</p>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(Object.keys(GITHUB_STAGE_LABEL) as GitHubStage[]).map((s) => (
          <div key={s} className={`rounded-xl px-3 py-2 text-center ${STAGE_TONE[s] ?? "bg-bg-raised text-text-muted"}`}><div className="text-lg font-semibold">{atLeast(g.stages[s], cov.issuesTruncated)}</div><div className="text-[11px]">{GITHUB_STAGE_LABEL[s]}</div></div>
        ))}
      </div>
      {open.length === 0 ? <Card><p className="text-sm">{cov.issuesTruncated ? "조회 범위 내 열린 이슈가 없습니다 (이슈 목록 잘림 — 오래된 이슈는 미확인)." : "열린 이슈가 없습니다 (GitHub 기준)."}</p></Card> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {open.map((x) => (
            <li key={x.number}><Card>
              <div className="mb-1 flex items-start justify-between gap-2">
                <a href={x.url} target="_blank" rel="noreferrer" className="min-w-0 break-words text-sm">#{x.number} {x.title}</a>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${STAGE_TONE[x.stage] ?? "bg-bg-raised text-text-muted"}`}>{GITHUB_STAGE_LABEL[x.stage]}</span>
              </div>
              <dl className="space-y-0.5 text-xs">
                <div className="flex gap-2"><dt className="w-14 shrink-0 text-text-faint">라벨</dt><dd>agent:{x.agent} · status:{x.statusLabel}</dd></div>
                <div className="flex gap-2"><dt className="w-14 shrink-0 text-text-faint">ACK</dt><dd className="min-w-0 break-words">{x.ack ? <><Ext href={x.ack.url}>{when(x.ack.at)}</Ext> · {x.ack.login} (코멘트 자기보고)</> : <span className="text-warn">{absence("ACK 코멘트", cov.commentsTruncated)}</span>}</dd></div>
                <div className="flex gap-2"><dt className="w-14 shrink-0 text-text-faint">완료보고</dt><dd className="min-w-0 break-words">{x.completion ? <><Ext href={x.completion.url}>{when(x.completion.at)}</Ext> · {x.completion.headline}</> : absence("완료보고", cov.commentsTruncated)}</dd></div>
                <div className="flex gap-2"><dt className="w-14 shrink-0 text-text-faint">PR</dt><dd className="min-w-0 break-words">{x.pull ? <><Ext href={x.pull.url}>#{x.pull.number}</Ext> · {x.pull.state} · head <code>{x.pull.headSha.slice(0, 7)}</code> · {x.pull.review}</> : "연결된 PR 없음"}</dd></div>
                <div className="flex gap-2"><dt className="w-14 shrink-0 text-text-faint">다음</dt><dd className="min-w-0 break-words">{x.nextAction} <span className="text-text-faint">({x.actor})</span></dd></div>
              </dl>
            </Card></li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** GitHub evidence line for one agent:* label group. */
export function GitHubAgentLine({ row, cov }: { row: GitHubAgentRow; cov?: EvidenceCoverage }) {
  // #67: when comments are truncated an older ACK may be outside the window: ACK'd is a lower bound, un-ACK'd an upper bound.
  const ct = cov?.commentsTruncated ?? false, it = cov?.issuesTruncated ?? false;
  const none = ct ? "조회 범위 내 없음" : "없음";
  return (
    <div className="mt-2 rounded-lg border border-border p-2 text-[11px]">
      <p className="text-text-muted"><span className="rounded bg-accent/15 px-1 text-[10px] text-accent">GitHub</span> agent:{row.label} 이슈 {atLeast(row.issues, it)} (열림 {atLeast(row.open, it)}) · ACK 있음 {atLeast(row.acked, ct || it)} / 없음 {ct ? `≤${row.unacked}` : row.unacked} · 열린 PR {row.openPulls} · 에이전트 조치 대기 {row.awaitingAgent}{ct || it ? " (부분 증거 — 조회 범위 내 집계)" : ""}</p>
      <p className="text-text-faint">마지막 ACK 코멘트 {row.lastAck ? <Ext href={row.lastAck.url}>{when(row.lastAck.at)}</Ext> : none} · 마지막 완료보고 {row.lastCompletion ? <Ext href={row.lastCompletion.url}>{when(row.lastCompletion.at)}</Ext> : none} — 코멘트 자기보고이며 런타임 ACK가 아님</p>
    </div>
  );
}
export function GitHubAgentsUnmapped({ ev, known }: { ev: Ev; known: string[] }) {
  const r = ev.state.kind === "ok" ? ev.state.data : null;
  if (!r) return <section aria-label="GitHub 에이전트 증거"><Head r={null} title="GitHub 에이전트 증거" /><LiveStatus s={ev.state} reload={ev.reload} what="GitHub 증거" /></section>;
  const rest = githubAgents(r).filter((x) => !x.agentKey || !known.includes(x.agentKey));
  return (
    <section aria-label="GitHub 에이전트 증거">
      <Head r={r} title="GitHub 에이전트 증거" stale={ev.error} />
      {rest.length === 0 ? <p className="text-[11px] text-text-faint">모든 agent:* 라벨이 위 에이전트 카드에 표시되었습니다.</p> : rest.map((x) => <GitHubAgentLine key={x.label} row={x} cov={evidenceCoverage(r)} />)}
    </section>
  );
}

export function GitHubActivityPanel({ ev, limit = 40 }: { ev: Ev; limit?: number }) {
  const r = ev.state.kind === "ok" ? ev.state.data : null;
  if (!r) return <section aria-label="GitHub 활동 증거"><Head r={null} title="GitHub 활동" /><LiveStatus s={ev.state} reload={ev.reload} what="GitHub 증거" /></section>;
  const events = githubActivity(r, limit);
  return (
    <section aria-label="GitHub 활동 증거">
      <Head r={r} title={`GitHub 활동 (최근 ${limit}건)`} stale={ev.error} />
      <p className="mb-2 text-[11px] text-text-faint">요약은 이벤트 유형·번호·작성자·짧은 SHA로 만든 고정 규칙 문장입니다(AI 요약 아님). 원문은 펼쳐서 확인하세요.</p>
      {events.length === 0 ? <p className="text-xs text-text-faint">{evidenceCoverage(r).partial ? "조회 범위 내 분류된 GitHub 활동(ACK/완료/리뷰/판정)이 없습니다 (부분 증거)." : "분류된 GitHub 활동(ACK/완료/리뷰/판정)이 없습니다."}</p> : (
        <ol className="space-y-2">
          {events.map((e, i) => (
            <Card key={`${e.url ?? e.at}-${i}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="rounded bg-bg-raised px-2 py-0.5 text-xs text-text-muted">{EVENT_KIND_LABEL[e.kind] ?? e.kind} · #{e.issue}{e.pull ? ` · PR #${e.pull}` : ""}</span>
                <span className="text-xs text-text-faint">{when(e.at)}</span>
              </div>
              <p className="mt-1 break-words text-sm">{summarizeEvent(e)}</p>
              <p className="mt-0.5 break-words text-[11px] text-text-faint">{shortenShas(e.text || "(빈 첫 줄)")}</p>
              <details className="mt-1 text-[11px]">
                <summary className="min-h-8 cursor-pointer py-1 text-accent">원문·출처</summary>
                <p className="break-all text-text-muted">{e.text || "(빈 첫 줄)"}</p>
                <p className="break-all text-text-faint">GitHub 로그인 {e.login}{e.bot ? " (bot)" : ""} · {e.url ? <Ext href={e.url}>출처 링크</Ext> : "링크 없음"}</p>
              </details>
            </Card>
          ))}
        </ol>
      )}
    </section>
  );
}

/** /tasks: remaining work vs historical completed/reviewed evidence, from GitHub issue state (labels are not completion). */
export function GitHubTaskSplitPanel({ ev }: { ev: Ev }) {
  const r = ev.state.kind === "ok" ? ev.state.data : null;
  if (!r) return <section aria-label="GitHub 작업 증거"><Head r={null} title="GitHub 작업 현황" /><LiveStatus s={ev.state} reload={ev.reload} what="GitHub 증거" /></section>;
  const s = githubTaskSplit(r), cov = evidenceCoverage(r);
  const line = (x: (typeof s.remaining)[number]) => (
    <li key={x.number} className="rounded-lg border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <a href={x.url} target="_blank" rel="noreferrer" className="min-w-0 break-words text-sm text-accent">#{x.number} {x.title}</a>
        <span className="shrink-0 rounded-full bg-bg-raised px-2 py-0.5 text-[11px] text-text-muted">{GITHUB_STAGE_LABEL[x.stage]}</span>
      </div>
      <p className="mt-1 break-words text-[11px] text-text-faint">라벨(자기보고): agent:{x.agent} · status:{x.statusLabel}</p>
      <p className="break-words text-[11px] text-text-muted">
        증거: {x.reviewedExact ? "현재 head 승인 확인" : "현재 head 승인 증거 없음"}{x.mergedPr ? ` · PR #${x.mergedPr} 병합` : ""}
      </p>
      {x.closurePending ? <p className="mt-1 rounded bg-warn/15 px-2 py-1 text-[11px] text-warn">PR 병합됨 · 이슈는 아직 열림 — 닫기 대기(완료 처리 아님)</p> : null}
    </li>
  );
  return (
    <section aria-label="GitHub 작업 증거" className="space-y-4">
      <Head r={r} title="GitHub 작업 현황" stale={ev.error} />
      <div>
        <h3 className="mb-2 text-sm font-semibold text-text-muted">남은 작업 <span className="tabular-nums">({atLeast(s.remaining.length, cov.issuesTruncated)})</span></h3>
        {s.remaining.length ? <ul className="space-y-2">{s.remaining.map(line)}</ul> : <p className="text-xs text-text-faint">열린 이슈 없음 (GitHub 기준{cov.issuesTruncated ? ", 조회 범위 내" : ""}).</p>}
      </div>
      <details>
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-text-muted">이력: 닫힌 이슈 (완료·검수 증거) <span className="tabular-nums">({atLeast(s.history.length, cov.issuesTruncated)})</span></summary>
        {s.history.length ? <ul className="mt-2 space-y-2">{s.history.map(line)}</ul> : <p className="text-xs text-text-faint">닫힌 이슈 없음.</p>}
      </details>
    </section>
  );
}
