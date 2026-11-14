"use client";
import { Card } from "@/components/ui";
import { LiveStatus } from "@/components/live/LiveStatus";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { BUCKET_LABEL, buildCards, parseRuns, parseWorkflows, summarize, type Bucket } from "./viewModel";

const POLL_MS = 15000;
const TONE: Record<Bucket, string> = { queued: "bg-warn/15 text-warn", running: "bg-accent/15 text-accent", completed: "bg-ok/15 text-ok", blocked: "bg-danger/15 text-danger", unknown: "bg-unknown/15 text-text-muted" };
const ts = (s: string | null) => { const d = s ? new Date(s) : null; return d && !Number.isNaN(d.getTime()) ? d.toISOString().replace("T", " ").slice(0, 19) + "Z" : "unknown"; };
const Row = ({ k, children }: { k: string; children: React.ReactNode }) => <div className="flex gap-2 text-xs"><dt className="w-16 shrink-0 text-text-faint">{k}</dt><dd className="min-w-0 break-all">{children}</dd></div>;

export function ProgressDashboard() {
  const runs = useAuthedJson("/api/runs", parseRuns, POLL_MS);
  const wfs = useAuthedJson("/api/collaboration", parseWorkflows, POLL_MS);
  const reload = () => { runs.reload(); wfs.reload(); };
  const note = <p className="mb-3 text-xs text-text-faint">자동 갱신: {POLL_MS / 1000}초 폴링 (실시간 푸시 아님) · 기존 읽기 API(/api/runs, /api/collaboration)만 사용 · API가 제공하지 않는 값은 “unknown”으로 표시</p>;
  const head = <div className="mb-2 flex items-center justify-between">{note}<button className="min-h-11 shrink-0 rounded-lg border border-border px-3 text-xs" onClick={reload}>새로고침</button></div>;
  if (runs.state.kind !== "ok") return <div>{head}<LiveStatus s={runs.state} reload={reload} what="실행 현황" /></div>;
  const cards = buildCards(runs.state.data, wfs.state.kind === "ok" ? wfs.state.data : []);
  const sum = summarize(cards);
  return (
    <div>
      {head}
      {wfs.state.kind !== "ok" && <div className="mb-3"><LiveStatus s={wfs.state} reload={reload} what="협업 워크플로(브랜치/PR 정보)" /></div>}
      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {(Object.keys(sum) as Bucket[]).map((b) => <div key={b} className={`rounded-xl px-3 py-2 text-center ${TONE[b]}`}><div className="text-lg font-semibold">{sum[b]}</div><div className="text-[11px]">{BUCKET_LABEL[b]}</div></div>)}
      </div>
      {cards.length === 0 ? <Card><p className="text-sm">기록된 실행이 없습니다 (empty). 실행 중인 것으로 가정하지 않습니다.</p></Card> : (
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
    </div>
  );
}
