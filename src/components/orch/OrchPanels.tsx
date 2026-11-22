"use client";
// Orchestrator engine panels for the live mobile tabs (프로젝트 / AI 팀 / PM 브리핑).
// Data: GET /api/orch. Switch changes: POST /api/orch (admin session + CSRF) → GitHub repository variables.
import { useRef, useState } from "react";
import { Card } from "@/components/ui";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { csrfHeaders, useSession } from "@/components/live/session";
import { formatKst, formatKstShort, formatKstTime } from "@/lib/time/kst";
import { refreshSucceeded } from "@/lib/orch/refresh";
import Link from "next/link";
import { AlertIcon, CheckIcon, EditIcon, KeyIcon, PauseIcon, RefreshIcon, StateIcon, StopIcon, type StateKind } from "@/components/icons";
import { FLAG_KEYS, approveMessage, latestUsage, planReviewBadge, roadmapCount, type FlagKey, type OrchRun, type PendingPlan, type PlanBadgeTone, type RepoView, type RoadmapItem, type RoadmapStatus, type RunStep, type UsageWindow } from "@/lib/orch/model";
import { LIFECYCLE, boardDeployCounts, boardNeedsUser, deployProgressText, stageBoard, type BoardColumn, type BoardItem } from "@/lib/orch/lifecycle";

type OrchData = { generatedAt: string; canWrite: boolean; repos: RepoView[] };

export function useOrch() {
  return useAuthedJson<OrchData>("/api/orch", (status, body) => {
    const j = body as (OrchData & { mode?: string }) | null;
    return j?.mode === "unconfigured" ? "unconfigured" : status === 200 && j?.mode === "live" && Array.isArray(j.repos) ? j : null;
  });
}

const tone = (r: OrchRun) =>
  r.status === "blocked" ? "border-danger/50 bg-danger/10"
  : r.status === "awaiting_merge" ? "border-warn/50 bg-warn/10"
  : r.held ? "border-border bg-bg-raised"
  : r.status === "done" ? "border-ok/30"
  : "border-accent/40";
const short = (repo: string) => repo.split("/")[1] ?? repo;

function StateNote({ kind }: { kind: string }) {
  const text: Record<string, string> = {
    loading: "엔진 상태를 불러오는 중입니다.",
    notoken: "로그인이 필요합니다.",
    unauth: "로그인이 만료되었습니다.",
    unconfigured: "엔진 연결이 설정되지 않았습니다 (ORCH_REPOS, ORCH_GITHUB_TOKEN).",
    error: "엔진 상태를 불러오지 못했습니다.",
  };
  return <p className="text-sm text-text-muted" data-testid="orch-state">{text[kind] ?? text.error}</p>;
}

function RunCard({ r }: { r: OrchRun }) {
  const stepText = r.status === "waiting" ? `${r.total}개 스텝` : `스텝 ${r.passed}/${r.total} 통과${r.step && !["done", "awaiting_merge", "finalizing"].includes(r.status) ? ` · 지금 ${r.step}번` : ""}`;
  return (
    <a href={r.url} target="_blank" rel="noreferrer" className={`block rounded-xl border p-3 ${tone(r)}`} data-testid={`orch-run-${short(r.repo)}-${r.number}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="break-words font-medium">{r.goal}</p>
        <span className="shrink-0 rounded-full bg-current/10 px-2 py-0.5 text-xs">{r.statusLabel}</span>
      </div>
      <p className="mt-1 text-xs text-text-muted">{short(r.repo)} #{r.number} · {stepText}{r.retries ? ` · 수정 ${r.retries}회` : ""}</p>
      {r.held && <p className="mt-1 text-xs text-warn"><PauseIcon className="mr-1 h-3.5 w-3.5 align-text-bottom" />{r.held}</p>}
      {r.reason && <p className="mt-1 break-words text-xs text-danger"><StopIcon className="mr-1 h-3.5 w-3.5 align-text-bottom" />{r.reason}</p>}
      <p className="mt-1 text-xs">다음 · {r.next}</p>
      {r.updatedAt && <p className="mt-1 text-[11px] text-text-muted">갱신 {formatKst(r.updatedAt)}</p>}
    </a>
  );
}

const isEnded = (r: OrchRun) => r.status === "done" || r.status === "cancelled";
const SUMMARY = "flex min-h-11 cursor-pointer items-center gap-2 py-2";

function StepDetails({ s, blocked }: { s: RunStep; blocked: boolean }) {
  const icon: StateKind = s.state === "passed" ? "done" : s.state === "current" ? (blocked ? "blocked" : "doing") : "todo";
  const label = s.state === "passed" ? "통과" : s.state === "current" ? (blocked ? "멈춤" : "진행 중") : "대기";
  return (
    <details open={s.state === "current"} className="rounded-lg border border-border" data-testid={`orch-step-${s.id}`}>
      <summary className={`${SUMMARY} px-2 text-sm`}>
        <span aria-label={label} role="img" className="shrink-0"><StateIcon kind={icon} /></span>
        <span className="min-w-0 break-words">Step {s.id}. {s.title}</span>
      </summary>
      <ul className="space-y-1 px-2 pb-2 text-xs">
        {s.checks.map((c, i) => (
          <li key={i} className="flex gap-1.5">
            <span aria-label={c.done ? "완료" : "미완료"} role="img" className="shrink-0"><StateIcon kind={c.done ? "done" : "todo"} className="h-3.5 w-3.5 translate-y-px" /></span>
            <span className="min-w-0 break-words">{c.text}</span>
          </li>
        ))}
        {!s.checks.length && <li className="text-text-muted">세부 할 일 없음</li>}
      </ul>
    </details>
  );
}

/** Run details (stage ③ row body): status, step progress, next action, steps → checks. */
function RunDetails({ r }: { r: OrchRun }) {
  const showNow = !!r.step && !["done", "awaiting_merge", "finalizing"].includes(r.status) && r.steps.some((s) => s.state === "current");
  const stepText = r.status === "waiting" ? `${r.total}개 스텝` : `스텝 ${r.passed}/${r.total} 통과${showNow ? ` · 지금 ${r.step}번` : ""}`;
  const pct = r.total ? Math.round((r.passed / r.total) * 100) : 0;
  return (
    <div className="space-y-1 pb-3">
      <p className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 text-text-muted">{stepText}{r.retries ? ` · 수정 ${r.retries}회` : ""}</span>
        <span className="shrink-0 rounded-full bg-current/10 px-2 py-0.5">{r.statusLabel}</span>
      </p>
      <span className="block h-1.5 overflow-hidden rounded-full bg-border" role="progressbar" aria-label="통과한 스텝" aria-valuemin={0} aria-valuemax={r.total} aria-valuenow={r.passed}>
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <p className="text-xs"><a href={r.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center underline">#{r.number} 열기</a>{r.finalPr ? ` · 최종 PR #${r.finalPr}` : ""}</p>
      {r.held && <p className="text-xs text-warn"><PauseIcon className="mr-1 h-3.5 w-3.5 align-text-bottom" />{r.held}</p>}
      {r.reason && <p className="break-words text-xs text-danger"><StopIcon className="mr-1 h-3.5 w-3.5 align-text-bottom" />{r.reason}</p>}
      <p className="text-xs">다음 · {r.next}</p>
      {r.updatedAt && <p className="text-[11px] text-text-muted">갱신 {formatKst(r.updatedAt)}</p>}
      <div className="space-y-1 pt-1">
        {r.steps.map((s) => <StepDetails key={s.id} s={s} blocked={r.status === "blocked"} />)}
      </div>
    </div>
  );
}

const ROADMAP_ICON: Record<RoadmapStatus, [StateKind, string]> = { done: ["done", "완료"], doing: ["doing", "진행 중"], todo: ["todo", "할 일"], na: ["na", "해당 없음"] };

/** Stage 0 (인프라) / 6 (확장) checklist row: '0 인프라 완료/전체' + small bar, expands to one line per item. */
function RoadmapRow({ n, title, items, testid }: { n: 0 | 6; title: string; items: RoadmapItem[]; testid: string }) {
  const c = roadmapCount(items);
  const allDone = c.total > 0 && c.done === c.total;
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  return (
    <details className="rounded-lg border border-border px-2" data-testid={testid}>
      <summary className={`${SUMMARY} text-sm`}>
        <span className="font-semibold">{n} {title}</span>
        {allDone && n === 0 ? <span className="inline-flex items-center gap-1 text-xs text-ok"><StateIcon kind="done" className="h-3.5 w-3.5" />인프라 완료</span> : <span className="inline-flex items-center gap-1 text-xs text-text-muted">{n === 0 && <StateIcon kind="done" className="h-3.5 w-3.5" />}{c.text}</span>}
        <span className="ml-auto block h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-border" role="progressbar" aria-label={`${title} 완료 항목`} aria-valuemin={0} aria-valuemax={c.total} aria-valuenow={c.done}>
          <span className="block h-full rounded-full bg-ok" style={{ width: `${pct}%` }} />
        </span>
      </summary>
      <ul className="space-y-1 pb-2 text-xs">
        {items.map((i) => (
          <li key={i.id} className="min-w-0">
            <p className="flex gap-1.5">
              <span aria-label={ROADMAP_ICON[i.status][1]} role="img" className="shrink-0"><StateIcon kind={ROADMAP_ICON[i.status][0]} className="h-3.5 w-3.5 translate-y-0.5" /></span>
              <span className="min-w-0 break-words"><span className="tabular-nums text-text-muted">{i.id}</span> {i.title}</span>
            </p>
            {i.note && <p className="truncate pl-6 text-[11px] text-text-muted" title={i.note}>{i.note}</p>}
          </li>
        ))}
        {!items.length && <li className="text-text-muted">항목 없음</li>}
      </ul>
    </details>
  );
}

const DEPLOY_TEXT = (d: boolean | null | undefined) => (d === true ? "배포됨" : d === false ? "배포 대기" : "배포 확인 불가");

/** One stage-board item line: '세부 id 상태 · 제목', or for 5 완료 '날짜 · 배포됨/배포 대기 · 제목'. */
function ItemLine({ item, done }: { item: BoardItem; done: boolean }) {
  return (
    <span className="block min-w-0 break-words text-xs">
      {item.blocked && <StopIcon className="mr-1 h-3.5 w-3.5 align-text-bottom text-danger" />}
      {done ? (
        <>
          <span className="tabular-nums text-text-muted">{formatKstShort(item.at, "날짜 없음")}</span>
          {" · "}
          <span className={item.deployed === false ? "text-warn" : item.deployed === true ? "text-ok" : "text-text-muted"}>{DEPLOY_TEXT(item.deployed)}</span>
        </>
      ) : (
        <><span className="tabular-nums text-text-muted">{item.sub}</span> <span className={item.blocked ? "text-danger" : undefined}>{item.label}</span></>
      )}
      {" · "}<span className="font-medium">{item.title}</span>
    </span>
  );
}

/** One item in a stage row: a run expands to its steps (RunDetails); a plan / idea shows its '#번호' Issue link. */
function BoardRow({ item, repo, done }: { item: BoardItem; repo: string; done: boolean }) {
  const r = item.run;
  if (item.kind === "run" && r) {
    return (
      <details className={`rounded-lg border px-2 ${tone(r)}`} data-testid={`orch-run-${short(repo)}-${r.number}`}>
        <summary className="flex min-h-11 cursor-pointer flex-col justify-center py-1.5">
          <ItemLine item={item} done={done} />
          {r.needsUser && <span className="mt-1 inline-block self-start rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">사용자 확인 필요</span>}
        </summary>
        <RunDetails r={r} />
      </details>
    );
  }
  const number = Number(item.key.split("-")[1]);
  return (
    <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-2" data-testid={`orch-${item.kind}-${short(repo)}-${number}`}>
      <span className="min-w-0 flex-1 py-1.5"><ItemLine item={item} done={done} /></span>
      <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 shrink-0 items-center text-xs text-accent underline">#{number}</a>
    </div>
  );
}

const DONE_FIRST = 5;

/** The stage's full process (LIFECYCLE subs); subs where an item sits now are highlighted. */
function StageProcess({ n, at }: { n: number; at: Set<string> }) {
  const step = LIFECYCLE[n - 1];
  return (
    <ol className="flex flex-wrap gap-1 text-[11px]" aria-label={`${step.title} 세부 과정`} data-testid={`orch-stage-process-${n}`}>
      {step.sub.map((x) => (
        <li key={x.id} className={`rounded px-1.5 py-0.5 ${at.has(x.id) ? "bg-accent-dim text-accent font-semibold" : "bg-bg text-text-muted"}`}>
          <span className="tabular-nums text-text-muted">{x.id}</span> {x.title}
        </li>
      ))}
    </ol>
  );
}

/** One stage row ('N 제목 · 설명 · 개수'), collapsed by default (card height limit); opening it shows the stage's process, then its items. */
function StageRow({ c, repo, deploy }: { c: BoardColumn; repo: string; deploy: string | null }) {
  const done = c.n === 5;
  const needs = boardNeedsUser(c);
  const counts = done ? boardDeployCounts(c) : null;
  const first = done ? c.items.slice(0, DONE_FIRST) : c.items;
  const rest = done ? c.items.slice(DONE_FIRST) : [];
  const empty = c.items.length === 0;
  const at = new Set(done ? [] : c.items.map((i) => i.sub));
  return (
    <details className="rounded-lg border border-border px-2" data-testid={`orch-stage-${c.n}`}>
      <summary className={`${SUMMARY} text-sm`}>
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="font-semibold">{c.n} {c.title}</span>
            {needs > 0 && <span className="shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">확인 필요 {needs}</span>}
            {counts && <span className="min-w-0 truncate text-[11px] text-text-muted" data-testid="orch-stage-deploy">배포 대기 {counts.pending} · 배포됨 {counts.deployed}</span>}
          </span>
          <span className="text-[11px] text-text-muted">{LIFECYCLE[c.n - 1].desc}</span>
        </span>
        <span className={`ml-auto shrink-0 tabular-nums ${empty ? "text-text-faint" : ""}`}><span className="sr-only"> · </span>{c.items.length}</span>
      </summary>
      <div className="space-y-1.5 pb-2">
        <StageProcess n={c.n} at={at} />
        {done && deploy && <p className="text-[11px] text-text-muted" data-testid="orch-deploy">다음 배포까지 {deploy}</p>}
        {first.map((item) => <BoardRow key={item.key} item={item} repo={repo} done={done} />)}
        {rest.length > 0 && (
          <details data-testid="orch-stage-more">
            <summary className={`${SUMMARY} text-xs text-text-muted`}>더보기 ({rest.length})</summary>
            <div className="space-y-1.5">{rest.map((item) => <BoardRow key={item.key} item={item} repo={repo} done={done} />)}</div>
          </details>
        )}
        {empty && <p className="text-xs text-text-muted">지금 이 단계에 있는 작업 없음</p>}
      </div>
    </details>
  );
}

function ProjectCard({ v }: { v: RepoView }) {
  const active = v.runs.filter((r) => !isEnded(r));
  const needs = v.runs.filter((r) => r.needsUser).length;
  const board = stageBoard({ runs: v.runs, plans: v.plans ?? [], ideas: v.ideas ?? [], pendingPrs: v.pendingPrs ?? null });
  const deploy = deployProgressText(v.deployPending ?? null, v.deployEvery ?? 10);
  const roadmapNote = v.roadmapError ? `로드맵 읽기 실패 · ${v.roadmapError}` : !v.roadmap ? "로드맵 없음(docs/roadmap.json)" : null;
  return (
    <Card>
      <details open data-testid={`orch-project-${short(v.repo)}`}>
        <summary className={`${SUMMARY} flex-wrap`}>
          <span className="font-semibold">{short(v.repo)}</span>
          <span className="text-xs text-text-muted">진행 중 {active.length}개</span>
          {needs > 0 && <span className="rounded-full bg-warn/20 px-2 py-0.5 text-xs">확인 필요 {needs}개</span>}
        </summary>
        <div className="space-y-2 pb-1">
          {roadmapNote ? <p className={`text-xs ${v.roadmapError ? "text-danger" : "text-text-muted"}`} data-testid="orch-roadmap-note">{roadmapNote}</p>
            : <RoadmapRow n={0} title="인프라" items={v.roadmap!.setup} testid="orch-roadmap-setup" />}
          <section aria-label="작업 흐름" className="space-y-1.5" data-testid="orch-flow">
            <h3 className="text-sm font-semibold">작업 흐름</h3>
            {v.runsError && <p className="text-xs text-danger">작업 불러오기 실패 · {v.runsError}</p>}
            {v.plansError && <p className="text-xs text-danger">계획 불러오기 실패 · {v.plansError}</p>}
            {v.ideasError && <p className="text-xs text-danger">아이디어 불러오기 실패 · {v.ideasError}</p>}
            {board.map((c) => <StageRow key={c.n} c={c} repo={v.repo} deploy={deploy} />)}
          </section>
          {!roadmapNote && <RoadmapRow n={6} title="확장" items={v.roadmap!.expansion} testid="orch-roadmap-expansion" />}
          <p className="text-xs"><Link href="/patch-notes" className="inline-flex min-h-11 items-center text-accent underline">작업 기록은 패치노트 탭</Link></p>
        </div>
      </details>
    </Card>
  );
}

/** 프로젝트 탭: 프로젝트마다 0 인프라 · 작업 흐름(1~5) · 6 확장, 모두 접고 펼 수 있음. */
export function OrchRunsPanel() {
  const { state, reload, error } = useOrch();
  const latest = useRef({ state, error }); latest.current = { state, error };
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  async function refresh() {
    setBusy(true);
    try {
      await reload();
      await new Promise((r) => setTimeout(r, 0)); // 상태 반영(렌더) 뒤 latest 를 읽기 위해 한 틱 양보
      const ok = refreshSucceeded(latest.current);
      setFailed(!ok);
      if (ok) setUpdatedAt(Date.now());
    } catch { setFailed(true); }
    finally { setBusy(false); }
  }
  return (
    <section aria-label="자동 진행 작업" className="space-y-2" data-testid="orch-runs">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text-muted">자동 진행 작업</h2>
        <button type="button" onClick={refresh} disabled={busy} data-testid="orch-refresh" className="min-h-11 rounded-lg border border-border px-3 text-xs disabled:opacity-50">{busy ? "불러오는 중…" : <span className="inline-flex items-center gap-1.5"><RefreshIcon className="h-3.5 w-3.5" />새로고침</span>}</button>
      </div>
      {updatedAt !== null && <p className="text-[11px] text-text-muted" data-testid="orch-refreshed">방금 갱신 {formatKstTime(updatedAt)}</p>}
      {failed && <p role="status" className="text-xs text-danger">새로고침 실패 · 잠시 후 다시</p>}
      {state.kind !== "ok" ? <Card><StateNote kind={state.kind} /></Card> : state.data.repos.map((v) => <ProjectCard key={v.repo} v={v} />)}
    </section>
  );
}

const BADGE_TONE: Record<PlanBadgeTone, string> = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  muted: "bg-current/10 text-text-muted",
};

function PlanCard({ p, canApprove, busy, armed, onArm, onApprove }: { p: PendingPlan; canApprove: boolean; busy: boolean; armed: boolean; onArm(): void; onApprove(): void }) {
  const badge = planReviewBadge(p.review);
  return (
    <div className="rounded-xl border border-border p-3" data-testid={`orch-plan-${short(p.repo)}-${p.number}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-medium">{p.goal}</p>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs ${BADGE_TONE[badge.tone]}`}>{badge.tone === "ok" ? <CheckIcon className="h-3 w-3" /> : badge.revise ? <EditIcon className="h-3 w-3" /> : badge.tone === "danger" ? <AlertIcon className="h-3 w-3" /> : null}{badge.text}</span>
      </div>
      <p className="mt-1 text-xs text-text-muted">{short(p.repo)} #{p.number} · 스텝 {p.steps}개</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        {canApprove && (
          <button type="button" disabled={busy} onClick={armed ? onApprove : onArm}
            className={`min-h-11 rounded-lg px-3 text-sm font-semibold disabled:opacity-50 ${armed ? "bg-warn/15 text-warn" : "border border-border"}`}>
            {busy ? "승인 중…" : armed ? "정말 시작할까요? 승인" : "승인"}
          </button>
        )}
        {canApprove && badge.revise && <span className="text-xs text-warn">감사에서 수정 필요 상태입니다</span>}
        <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-xs underline">계획 보기</a>
      </div>
    </div>
  );
}

/** PM 브리핑 탭: orch:go 전의 '[plan]' Issue와 계획 감사 결과. 관리자는 2단계 탭으로 승인(orch:go). */
export function OrchPlansPanel() {
  const { state, reload } = useOrch();
  const session = useSession();
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (state.kind !== "ok") return null; // OrchDecisionsPanel shows the loading / error note
  const plans = state.data.repos.flatMap((v) => v.plans ?? []);
  const errors = state.data.repos.filter((v) => v.plansError);
  const canApprove = session.role === "admin" && state.data.canWrite;

  async function approve(p: PendingPlan) {
    const key = `${p.repo}#${p.number}`;
    setBusy(key); setMsg(null);
    try {
      const r = await fetch("/api/orch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify({ action: "approve", repo: p.repo, issue: p.number, hash: p.hash }) });
      const res = approveMessage(r.status, await r.json().catch(() => null));
      setMsg(res.text);
      if (res.ok) await reload();
    } catch { setMsg("승인 실패 · 네트워크 오류"); }
    finally { setBusy(null); setArmed(null); }
  }

  const status = msg && <p role="status" className="rounded-xl border border-border bg-bg-raised p-2 text-xs">{msg}</p>;
  const errorLines = errors.map((v) => <p key={v.repo} className="text-xs text-danger">{short(v.repo)} 계획 불러오기 실패 · {v.plansError}</p>);
  if (!plans.length) return <div className="space-y-2" data-testid="orch-plans">{status}{errorLines}<p className="text-sm text-text-muted">승인 대기 계획 없음</p></div>;
  return (
    <section aria-label="승인 대기 계획" className="space-y-2" data-testid="orch-plans">
      <h2 className="text-sm font-semibold text-text-muted">승인 대기 계획 · {plans.length}</h2>
      {status}
      {errorLines}
      {plans.map((p) => {
        const key = `${p.repo}#${p.number}`;
        return <PlanCard key={key} p={p} canApprove={canApprove} busy={busy !== null} armed={armed === key} onArm={() => { setArmed(key); setMsg(null); }} onApprove={() => approve(p)} />;
      })}
      {!canApprove && <p className="text-xs text-text-muted">{session.role !== "admin" ? "관리자 로그인에서만 승인할 수 있습니다." : "서버에 쓰기 토큰(ORCH_GITHUB_TOKEN)이 없어 승인할 수 없습니다."}</p>}
    </section>
  );
}

/** PM 브리핑 탭: 사용자 판단이 필요한 작업만. */
export function OrchDecisionsPanel() {
  const { state } = useOrch();
  if (state.kind !== "ok") return <section aria-label="엔진 결정 필요" className="space-y-2"><h2 className="text-sm font-semibold text-text-muted">엔진 · 결정 필요</h2><Card><StateNote kind={state.kind} /></Card></section>;
  const runs = state.data.repos.flatMap((v) => v.runs).filter((r) => r.needsUser || r.held);
  return (
    <section aria-label="엔진 결정 필요" className="space-y-2" data-testid="orch-decisions">
      <h2 className="text-sm font-semibold text-text-muted">엔진 · 결정 필요 · {runs.filter((r) => r.needsUser).length}</h2>
      {runs.map((r) => <RunCard key={`${r.repo}#${r.number}`} r={r} />)}
      {!runs.length && <p className="text-sm text-text-muted">없음 — 모든 작업이 자동으로 진행 중입니다.</p>}
    </section>
  );
}

const FLAG_TEXT: Record<FlagKey, { name: string; off: string }> = {
  sonnet: { name: "Claude Sonnet (구현)", off: "Opus가 대신 구현" },
  opus: { name: "Claude Opus (고난도 구현·대체 검수)", off: "Sonnet이 대신 구현, 대체 검수 없음" },
  codex: { name: "Codex (독립 검수)", off: "Opus가 바로 검수" },
  paused: { name: "전체 일시정지", off: "" },
};

/** AI 팀 탭: 저장소별 ON/OFF. 관리자 세션에서만 조작 가능. */
export function OrchSwitchesPanel() {
  const { state, reload } = useOrch();
  const session = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const canEdit = session.role === "admin" && state.kind === "ok" && state.data.canWrite;

  async function change(repo: string, key: string, value: boolean | string) {
    setBusy(`${repo}:${key}`); setMsg(null);
    try {
      const r = await fetch("/api/orch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify({ repo, key, value }) });
      const j = await r.json().catch(() => null);
      setMsg(r.ok ? `저장됨 · 새 작업부터 적용${j?.woke ? ", 대기 작업은 지금 재개 요청" : " (최대 20분 내 반영)"}` : `저장 실패 · ${j?.detail ?? j?.error ?? r.status}`);
      await reload();
    } catch { setMsg("저장 실패 · 네트워크 오류"); }
    finally { setBusy(null); }
  }

  return (
    <section aria-label="엔진 ON/OFF" className="space-y-2" data-testid="orch-switches">
      <h2 className="text-lg font-semibold">AI ON/OFF</h2>
      <p className="text-xs text-text-muted">끄면 새 작업만 막고, 이미 실행 중인 작업은 끝까지 진행합니다. GitHub 저장소 변수에 저장되어 이 앱이 꺼져 있어도 지켜집니다.</p>
      {msg && <p role="status" className="rounded-xl border border-border bg-bg-raised p-2 text-xs">{msg}</p>}
      {state.kind !== "ok" ? <Card><StateNote kind={state.kind} /></Card> : state.data.repos.map((v) => (
        <Card key={v.repo} className="space-y-3">
          <p className="font-semibold">{short(v.repo)}</p>
          {!v.switches ? <p className="text-xs text-danger">스위치를 읽지 못했습니다 · {v.switchesError}</p> : <>
            {FLAG_KEYS.map((k) => {
              const on = v.switches![k];
              const label = k === "paused" ? (on ? "정지됨" : "운영 중") : on ? "ON" : "OFF";
              const active = k === "paused" ? !on : on;
              return (
                <div key={k} className="flex items-center justify-between gap-3">
                  <div><p className="text-sm">{FLAG_TEXT[k].name}</p>{!active && FLAG_TEXT[k].off && <p className="text-xs text-text-muted">꺼짐 · {FLAG_TEXT[k].off}</p>}</div>
                  <button role="switch" aria-checked={active} aria-label={`${short(v.repo)} ${FLAG_TEXT[k].name}`} disabled={!canEdit || busy !== null}
                    onClick={() => change(v.repo, k, !on)}
                    className={`min-h-11 min-w-20 shrink-0 rounded-full px-3 text-sm font-semibold disabled:opacity-50 ${active ? "bg-accent text-white" : "bg-border text-text-muted"}`}>
                    {busy === `${v.repo}:${k}` ? "…" : label}
                  </button>
                </div>
              );
            })}
            <WindowEditor repo={v.repo} value={v.switches.window} disabled={!canEdit || busy !== null} onSave={(w) => change(v.repo, "window", w)} />
          </>}
        </Card>
      ))}
      {state.kind === "ok" && !canEdit && <p className="text-xs text-text-muted">{session.role !== "admin" ? "관리자 로그인에서만 바꿀 수 있습니다." : "서버에 쓰기 토큰(ORCH_GITHUB_TOKEN)이 없어 읽기만 가능합니다."}</p>}
    </section>
  );
}

function WindowEditor({ repo, value, disabled, onSave }: { repo: string; value: string; disabled: boolean; onSave(v: string): void }) {
  const [w, setW] = useState(value);
  return (
    <div className="space-y-1">
      <label className="block text-sm" htmlFor={`win-${repo}`}>작업 시간대 (한국시간, 비우면 항상)</label>
      <div className="flex gap-2">
        <input id={`win-${repo}`} value={w} onChange={(e) => setW(e.target.value)} placeholder="08:00-24:00" inputMode="numeric"
          className="min-h-11 flex-1 rounded-xl border border-border bg-bg-raised px-3 text-sm" />
        <button disabled={disabled || w.trim() === value} onClick={() => onSave(w.trim())} className="min-h-11 rounded-xl border border-border px-3 text-sm disabled:opacity-50">저장</button>
      </div>
    </div>
  );
}

function Bar({ label, w }: { label: string; w: UsageWindow | null }) {
  const p = w?.pct ?? null;
  const left = p === null ? null : Math.max(0, Math.round((100 - p) * 10) / 10);
  const color = p === null ? "bg-text-faint" : p >= 90 ? "bg-danger" : p >= 70 ? "bg-warn" : "bg-accent";
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-sm">
        <span>{label}</span>
        <span className="font-semibold">{p === null ? "확인 불가" : `${p}% 사용 · ${left}% 남음`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-border"><div className={`h-full ${color}`} style={{ width: `${Math.min(100, p ?? 0)}%` }} /></div>
      <p className="text-[11px] text-text-muted">리셋 {w?.resetsAt ? formatKst(w.resetsAt) : "확인 불가"}</p>
    </div>
  );
}

/** AI 팀 탭: 구독 사용량 (계정 전체 기준, orch:usage 스냅샷). */
export function OrchUsagePanel() {
  const { state, reload } = useOrch();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (state.kind !== "ok") return <section aria-label="AI 사용량" className="space-y-2"><h2 className="text-lg font-semibold">AI 사용량</h2><Card><StateNote kind={state.kind} /></Card></section>;
  const u = latestUsage(state.data.repos);
  const canRefresh = session.role === "admin" && state.data.canWrite;

  async function refresh() {
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/orch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify({ action: "refresh-usage" }) });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; results?: { result: string }[]; error?: string } | null;
      const running = j?.results?.some((x) => x.result === "running");
      setMsg(r.ok && j?.ok ? (running ? "방금 확인을 시작했습니다 · 1~2분 뒤 자동 반영" : "확인 요청함 · 1~2분 뒤 자동 반영") : `요청 실패 · ${j?.error ?? r.status}`);
      await reload();
    } catch { setMsg("요청 실패 · 네트워크 오류"); }
    finally { setBusy(false); }
  }

  return (
    <section aria-label="AI 사용량" className="space-y-2" data-testid="orch-usage">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">AI 사용량</h2>
        {canRefresh && <button type="button" onClick={refresh} disabled={busy} data-testid="usage-refresh" className="min-h-11 rounded-lg border border-border px-3 text-xs disabled:opacity-50">{busy ? "요청 중…" : <span className="inline-flex items-center gap-1.5"><RefreshIcon className="h-3.5 w-3.5" />지금 확인</span>}</button>}
      </div>
      {msg && <p role="status" className="rounded-xl border border-border bg-bg-raised p-2 text-xs">{msg}</p>}
      {u && state.data.repos.some((r) => r.usageRefresh === "requested" || r.usageRefresh === "running") && <p className="text-[11px] text-text-muted" data-testid="usage-refreshing">값이 1시간 넘게 지나 새로 확인하는 중입니다. 1~2분 뒤 새로고침하면 반영됩니다.</p>}
      {!u ? <Card><p className="text-sm text-text-muted">아직 사용량 기록이 없습니다. 엔진의 usage 작업이 처음 돌면 표시됩니다.</p></Card> : <>
        <Card className="space-y-3">
          <p className="font-semibold">Claude <span className="text-xs font-normal text-text-muted">구독 전체 · 직접 대화 포함</span></p>
          {u.claude ? <><Bar label="5시간" w={u.claude.fiveHour} /><Bar label="7일" w={u.claude.sevenDay} /></> : <p className="text-sm text-text-muted">확인 불가{u.claudeError ? ` · ${u.claudeError}` : ""}</p>}
          <p className="text-[11px] text-text-muted">확인 {formatKst(u.claudeCheckedAt, "없음")}{u.claude && u.claudeError ? ` · 이번 확인: ${u.claudeError}` : ""}</p>
        </Card>
        <Card className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <p className="font-semibold">Codex</p>
            {u.codex.limited && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs text-warn">한도 소진 · Opus 대체 검수</span>}
          </div>
          {u.codex.fiveHour || u.codex.weekly ? <><Bar label="5시간" w={u.codex.fiveHour} /><Bar label="주간" w={u.codex.weekly} /></> : <p className="text-sm text-text-muted">사용률 확인 불가</p>}
          {u.codex.needsLogin && <p className="rounded-lg border border-warn/50 bg-warn/10 p-2 text-xs text-warn"><KeyIcon className="mr-1 h-3.5 w-3.5 align-text-bottom" />폰 로그인 필요 — GitHub Actions → codex-login → Run workflow 후 표시되는 코드로 승인</p>}
          <p className="text-[11px] text-text-muted">확인 {formatKst(u.codex.checkedAt, "없음")}{u.codex.error && !u.codex.needsLogin ? ` · 이번 조회: ${u.codex.error}` : ""}</p>
        </Card>
      </>}
    </section>
  );
}
