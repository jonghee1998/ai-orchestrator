"use client";
import { Card } from "@/components/ui";
import { LiveStatus } from "@/components/live/LiveStatus";
import { useAuthedJson, type Live } from "@/components/live/useAuthedJson";
import { GitHubProgressPanel, useGitHubEvidence } from "@/components/github/GitHubEvidencePanels";
import { BUCKET_LABEL, buildCards, parseRuns, parseWorkflows, summarize, type Bucket, type RunRow, type WorkflowRow } from "./viewModel";

const POLL_MS = 15000;
const TONE: Record<Bucket, string> = { queued: "bg-warn/15 text-warn", running: "bg-accent/15 text-accent", completed: "bg-ok/15 text-ok", blocked: "bg-danger/15 text-danger", unknown: "bg-unknown/15 text-text-muted" };
const ts = (s: string | null) => { const d = s ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 19) + "Z" : "unknown"; };
const Row = ({ k, children }: { k: string; children: React.ReactNode }) => <div className="flex gap-2 text-xs"><dt className="w-16 shrink-0 text-text-faint">{k}</dt><dd className="min-w-0 break-all">{children}</dd></div>;

export function ProgressDashboard() {
  const runs = useAuthedJson("/api/runs", parseRuns, POLL_MS);
  const wfs = useAuthedJson("/api/collaboration", parseWorkflows, POLL_MS);
  const gh = useGitHubEvidence();
  const reload = () => { runs.reload(); wfs.reload(); gh.reload(); };
  const note = <p className="mb-3 text-xs text-text-faint">자동 갱신: {POLL_MS / 1000}초 폴링 (실시간 푸시 아님) · 내부 런타임: /api/runs, /api/collaboration · GitHub 증거: /api/evidence (별도 표시, 서로 합산하지 않음) · API가 제공하지 않는 값은 “unknown”으로 표시</p>;
  const head = <div className="mb-2 flex items-center justify-between">{note}<button className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-xs" onClick={reload}>새로고침</button></div>;
  return (
    <div className="space-y-6">
      <div>{head}<InternalRuntime runs={runs} wfs={wfs} reload={reload} /></div>
      <GitHubProgressPanel ev={gh} />
    </div>
  );
}

const RuntimeHead = () => <div className="mb-2"><h2 className="text-sm font-semibold text-text-muted">내부 런타임 기록 <span className="rounded bg-bg-raised px-1.5 py-0.5 text-[10px] text-text-faint">오케스트레이터 저장소</span></h2><p className="text-[11px] text-text-faint">오케스트레이터가 dispatch·콜백으로 기록한 실행만 집계 (GitHub 이슈/코멘트 미포함)</p></div>;
function InternalRuntime({ runs, wfs, reload }: { runs: { state: Live<RunRow[]> }; wfs: { state: Live<WorkflowRow[]> }; reload: () => void }) {
  if (runs.state.kind !== "ok") return <section aria-label="내부 런타임 기록"><RuntimeHead /><LiveStatus s={runs.state} reload={reload} what="내부 실행 현황" /></section>;
  const cards = buildCards(runs.state.data, wfs.state.kind === "ok" ? wfs.state.data : []);
  const sum = summarize(cards);
  return (
    <section aria-label="내부 런타임 기록">
      <RuntimeHead />
      {wfs.state.kind !== "ok" && <div className="mb-3"><LiveStatus s={wfs.state} reload={reload} what="협업 워크플로(브랜치/PR 정보)" /></div>}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {(Object.keys(sum) as Bucket[]).map((b) => <div key={b} className={`rounded-xl px-3 py-2 text-center ${TONE[b]}`}><div className="text-lg font-semibold">{sum[b]}</div><div className="text-[11px]">{BUCKET_LABEL[b]}</div></div>)}
      </div>
      {cards.length === 0 ? <Card><p className="text-sm">내부 런타임 실행 기록 0건 — 오케스트레이터 경유 dispatch/콜백이 없다는 뜻입니다. 실행 중으로 가정하지 않으며, GitHub 작업 진행은 아래 GitHub 증거에서 별도로 확인합니다.</p></Card> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {cards.map((c) => (
            <li key={c.dispatchId}><Card>
              <div className="mb-2 flex items-center justify-between gap-2"><b className="text-sm">{c.agent}</b><span className={`rounded-full px-2.5 py-1 text-xs ${TONE[c.bucket]}`}>{BUCKET_LABEL[c.bucket]} · {c.status}</span></div>
              <dl className="space-y-1">
                <Row k="작업">{c.task}</Row>
                <Row k="브랜치">{c.branch ?? "unknown"}</Row>
                <Row k="SHA">{c.sha ? <code>{c.sha}</code> : "unknown"}{c.shaKind && <span className="text-text-faint"> ({c.shaKind === "head" ? "보고된 head" : "대상 target"})</span>}</Row>
                <Row k="ACK"><span className={c.ack.verified ? "text-ok" : "text-warn"}>{c.ack.text}</span></Row>
                <Row k="마지막">{ts(c.lastEvent)}</Row>
                <Row k="링크">{c.links.length ? c.links.map((l) => <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="mr-2 inline-block min-h-6 text-accent underline">{l.label}</a>) : "unknown"}</Row>
                <Row k="검수">{c.findings ?? "없음/unknown"}</Row>
                {c.error && <Row k="오류"><span className="text-danger">{c.error}</span></Row>}
                <Row k="다음">{c.nextAction}</Row>
              </dl>
            </Card></li>
          ))}
        </ul>
      )}
    </section>
  );
}
