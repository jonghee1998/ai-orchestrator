"use client";
// Issue #60 — GitHub-backed collaboration evidence. Read-only; GitHub evidence is shown apart from runtime proof.
import { Card, PageTitle } from "@/components/ui";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { LiveStatus } from "@/components/live/LiveStatus";
import { parseEvidenceResponse } from "@/lib/github/evidence-views";
import type { CommentEvidence, EvidenceReport, IssueEvidence, PullEvidence } from "@/lib/github/evidence";

const accept = parseEvidenceResponse;
const when = (iso?: string) => (iso ? iso.replace("T", " ").slice(0, 16) + "Z" : "unknown");
const Ext = ({ href, children }: { href?: string; children: React.ReactNode }) =>
  href ? <a href={href} target="_blank" rel="noreferrer" className="text-accent break-all">{children}</a> : <>{children}</>;

function CommentLine({ c, tag }: { c: CommentEvidence; tag: string }) {
  return <li className="break-words"><span className="text-text-faint">{tag}</span> <Ext href={c.url}>{when(c.at)}</Ext> · {c.login}{c.bot ? " (bot)" : ""} — {c.headline || "(빈 첫 줄)"}</li>;
}
function Pull({ p }: { p: PullEvidence }) {
  return (
    <div className="mt-2 rounded-lg border border-border p-2 text-[12px]">
      <p className="break-words"><Ext href={p.url}>PR #{p.number}</Ext> · {p.state}{p.draft ? " (draft)" : ""} · <code>{p.head}</code> → <code>{p.base}</code></p>
      <p className="text-text-faint">head {p.headSha.slice(0, 7)} · 연결 근거 {p.linkedBy.join("+")}</p>
      {p.detail === "skipped" ? <p className="text-text-faint">리뷰/커밋 상세 미조회 (상한 초과) — unknown</p> : <>
        <p>커밋 {p.commits.count}{p.commits.truncated ? "+ (잘림)" : ""} · 최근 {when(p.commits.latestAt)} · 수정 라운드 {p.revisions}</p>
        <p>리뷰 {p.reviews.length ? p.reviews.map((r) => `${r.login}:${r.state}`).join(", ") : "없음"}</p>
        {p.reviewRequest && <p>PM 리뷰 요청 <Ext href={p.reviewRequest.url}>{p.reviewRequest.sha.slice(0, 7)}</Ext> ({p.reviewRequest.onHead ? "현재 head" : "이전 head"}, {when(p.reviewRequest.at)})</p>}
        {p.botReviewOnHead && <p>봇 리뷰(현재 head) <Ext href={p.botReviewOnHead.url}>{p.botReviewOnHead.login}</Ext> {when(p.botReviewOnHead.at)}</p>}
        {p.decision && <p>최근 판정 <Ext href={p.decision.url}>{p.decision.kind}</Ext> ({p.decision.source}, {p.decision.by}, {when(p.decision.at)}) · 이후 커밋 {p.decision.commitsAfter}{p.decision.headMoved ? " · head 변경됨" : ""}{p.decision.stackedPulls.length ? ` · 스택 PR ${p.decision.stackedPulls.map((n) => `#${n}`).join(", ")}` : ""}</p>}
      </>}
      {p.comments.filter((c) => c.kind !== "other").length > 0 && <ul className="mt-1 space-y-0.5">{p.comments.filter((c) => c.kind !== "other").map((c) => <CommentLine key={c.id} c={c} tag={c.kind} />)}</ul>}
    </div>
  );
}
function Issue({ i }: { i: IssueEvidence }) {
  return (
    <Card>
      <a href={i.url} target="_blank" rel="noreferrer" className="block break-words text-sm">#{i.number} {i.title}</a>
      <p className="text-[11px] text-text-faint">agent:{i.agent} · status:{i.status} · 코멘트 {i.comments}</p>
      <p className="mt-1 text-sm"><span className="text-text-faint">다음 조치</span> {i.nextAction.label} <span className="text-text-faint">({i.nextAction.actor})</span></p>
      <ul className="mt-1 space-y-0.5 text-[12px]">
        {i.acks.length ? i.acks.map((c) => <CommentLine key={c.id} c={c} tag="ACK" />) : <li className="text-text-faint">ACK 코멘트 없음</li>}
        {i.completions.map((c) => <CommentLine key={c.id} c={c} tag="완료보고" />)}
      </ul>
      {i.pulls.map((p) => <Pull key={p.number} p={p} />)}
    </Card>
  );
}

export default function EvidencePage() {
  const { state, reload, error } = useAuthedJson<EvidenceReport>("/api/evidence", accept, 60_000);
  const r = state.kind === "ok" ? state.data : null;
  const open = r?.issues.filter((i) => i.state === "open") ?? [];
  const closed = r?.issues.filter((i) => i.state === "closed").slice(0, 10) ?? [];
  return (
    <div className="space-y-3">
      <PageTitle title="GitHub 증거" subtitle="이슈·ACK·PR·리뷰·수정·다음 조치 — GitHub API 실측, 읽기 전용" />
      <LiveStatus s={state} reload={reload} what="GitHub 증거" error={error} />
      {r && <>
        <Card>
          <p className="text-sm">출처: GitHub <code>{r.repo}</code> · 생성 {when(r.generatedAt)}</p>
          <p className="mt-1 text-[11px] text-text-faint">{r.identityNote} 런타임 증명: 포함 안 함(세션 콜백 #59 보류).</p>
          <p className="mt-1 text-[11px] text-text-faint">이슈 {r.limits.issues}{r.limits.issuesTruncated ? " (잘림 — 오래된 이슈 누락)" : ""} · PR {r.limits.pulls}{r.limits.pullsTruncated ? " (잘림)" : ""} · 코멘트 {r.limits.comments}{r.limits.commentsTruncated ? " (최근분만)" : ""} · 상세 PR {r.limits.detailedPulls}</p>
        </Card>
        <h2 className="text-sm font-semibold text-text-muted">열린 이슈 · {open.length}</h2>
        {open.map((i) => <Issue key={i.number} i={i} />)}
        {closed.length > 0 && <h2 className="text-sm font-semibold text-text-muted">최근 닫힌 이슈 · {closed.length}</h2>}
        {closed.map((i) => <Issue key={i.number} i={i} />)}
      </>}
    </div>
  );
}
