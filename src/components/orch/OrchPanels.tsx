"use client";
// Orchestrator engine panels for the live mobile tabs (프로젝트 / AI 팀 / PM 브리핑).
// Data: GET /api/orch. Switch changes: POST /api/orch (admin session + CSRF) → GitHub repository variables.
import { useEffect, useId, useRef, useState } from "react";
import { BUTTON, CARD_TITLE, Card, FIELD, ICON_BUTTON, PRIMARY_BUTTON, PageTitle, ROW, STATUS_BOX } from "@/components/ui";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { csrfHeaders, useSession } from "@/components/live/session";
import { formatKst, formatKstShort, formatKstTime } from "@/lib/time/kst";
import { refreshSucceeded } from "@/lib/orch/refresh";
import Link from "next/link";
import { AlertIcon, ArrowRightIcon, CheckIcon, ChevronIcon, EditIcon, KeyIcon, PauseIcon, RefreshIcon, StateIcon, StopIcon, type StateKind } from "@/components/icons";
import { FLAG_KEYS, approveMessage, latestUsage, mergedSwitches, type SwitchKey, phaseStatus, planReviewBadge, roadmapCount, type FlagKey, type OrchRun, type PendingPlan, type PlanBadgeTone, type RepoView, type RoadmapItem, type RoadmapStatus, type RunStep, type UsageWindow } from "@/lib/orch/model";
import { activeAgents, type AgentId } from "@/lib/orch/agents";
import { WRITE_UNCONFIGURED_TEXT, alignResultMessage, alignSwitches, differsText, switchResultMessage, type SwitchAllResponse, type SwitchMessage } from "@/lib/orch/switchUi";
import { readCollapsed, toggleCollapsed, writeCollapsed } from "@/lib/orch/collapse";
import { LIFECYCLE, boardNeedsUser, boardRemaining, columnRemaining, itemProgress, phaseBoard, stageBoard, type BoardColumn, type BoardItem, type DonePhase, type PhaseColumn, type PhaseGroup } from "@/lib/orch/lifecycle";

type OrchData = { generatedAt: string; canWrite: boolean; repos: RepoView[] };

export function useOrch() {
  return useAuthedJson<OrchData>("/api/orch", (status, body) => {
    const j = body as (OrchData & { mode?: string }) | null;
    return j?.mode === "unconfigured" ? "unconfigured" : status === 200 && j?.mode === "live" && Array.isArray(j.repos) ? j : null;
  });
}

/** 작업 상태 배지 색 (같은 상태 = 같은 상태색). 카드 안 한 줄이므로 테두리 대신 배지로 표시한다. */
const tone = (r: OrchRun) =>
  r.status === "blocked" ? "bg-danger/10 text-danger"
  : r.status === "awaiting_merge" ? "bg-warn/10 text-warn"
  : r.held ? "bg-unknown/10 text-text-muted"
  : r.status === "done" ? "bg-ok/10 text-ok"
  : "bg-accent-dim text-accent";
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
  const stepText = r.status === "waiting" ? `${r.total}개 스텝` : `스텝 ${r.passed}/${r.total} 통과${r.step && !["done", "awaiting_merge", "finalizing", "rechecking"].includes(r.status) ? ` · 지금 ${r.step}번` : ""}`;
  return (
    <a href={r.url} target="_blank" rel="noreferrer" className={`block ${ROW} text-sm`} data-testid={`orch-run-${short(r.repo)}-${r.number}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-semibold">{r.goal}</p>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${tone(r)}`}>{r.statusLabel}</span>
      </div>
      <p className="mt-[3px] text-xs tabular-nums text-text-muted">{short(r.repo)} #{r.number} · {stepText}{r.retries ? ` · 수정 ${r.retries}회` : ""}</p>
      {r.held && <p className="mt-1 text-xs text-warn"><PauseIcon className="mr-1 h-3.5 w-3.5 align-text-bottom" />{r.held}</p>}
      {r.reason && <p className="mt-1 break-words text-xs text-danger"><StopIcon className="mr-1 h-3.5 w-3.5 align-text-bottom" />{r.reason}</p>}
      <p className="mt-1 text-xs">다음 · {r.next}</p>
      {r.updatedAt && <p className="mt-1 text-[11px] text-text-muted">갱신 {formatKst(r.updatedAt)}</p>}
    </a>
  );
}

const SUMMARY = "flex min-h-11 cursor-pointer items-center gap-2 py-2";

function StepDetails({ s, blocked }: { s: RunStep; blocked: boolean }) {
  const icon: StateKind = s.state === "passed" ? "done" : s.state === "current" ? (blocked ? "blocked" : "doing") : "todo";
  const label = s.state === "passed" ? "통과" : s.state === "current" ? (blocked ? "멈춤" : "진행 중") : "대기";
  return (
    <details open={s.state === "current"} className="rounded-lg border border-border" data-testid={`orch-step-${s.id}`}>
      <summary className={`${SUMMARY} px-2 text-sm`}>
        <span aria-label={label} role="img" className="shrink-0"><StateIcon kind={icon} /></span>
        <span className="min-w-0 flex-1 break-words">Step {s.id}. {s.title}</span>
        <ChevronIcon className="h-4 w-4" />
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

/** Run details (item card '스텝 보기'): status, step progress, next action, steps → checks. */
function RunDetails({ r }: { r: OrchRun }) {
  const showNow = !!r.step && !["done", "awaiting_merge", "finalizing", "rechecking"].includes(r.status) && r.steps.some((s) => s.state === "current");
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

/**
 * One roadmap line: status icon · id · title, note below in small gray. With `repo`, a positive-integer ref becomes a
 * '#번호' link to that repo's Issue (new tab), and a 'doing' item is bold (진행 단계 목록).
 */
function RoadmapRow({ i, repo }: { i: RoadmapItem; repo?: string }) {
  const link = repo && typeof i.ref === "number" ? i.ref : null;
  const bold = repo !== undefined && i.status === "doing";
  return (
    <li className="min-w-0" data-status={repo ? i.status : undefined}>
      <p className={`flex gap-1.5${bold ? " font-semibold" : ""}`}>
        <span aria-label={ROADMAP_ICON[i.status][1]} role="img" className="shrink-0"><StateIcon kind={ROADMAP_ICON[i.status][0]} className="h-3.5 w-3.5 translate-y-0.5" /></span>
        <span className="min-w-0 break-words"><span className="tabular-nums font-normal text-text-muted">{i.id}</span> {i.title}
          {link !== null && <>{" "}<a href={`https://github.com/${repo}/issues/${link}`} target="_blank" rel="noreferrer"
            className="-my-3 inline-flex min-h-11 items-center font-normal tabular-nums text-accent">#{link}</a></>}
        </span>
      </p>
      {i.note && <p className="truncate pl-6 text-[11px] text-text-muted" title={i.note}>{i.note}</p>}
    </li>
  );
}

/** Roadmap checklist (펼친 '인프라 · 확장' 줄 안): one line per item. */
function RoadmapList({ title, items, testid }: { title: string; items: RoadmapItem[]; testid: string }) {
  return (
    <div className="pt-1" data-testid={testid}>
      <p className="text-xs font-semibold">{title} <span className="font-normal tabular-nums text-text-muted">{roadmapCount(items).text}</span></p>
      <ul className="space-y-1 py-1 text-xs">
        {items.map((i) => <RoadmapRow key={i.id} i={i} />)}
        {!items.length && <li className="text-text-muted">항목 없음</li>}
      </ul>
    </div>
  );
}

/** '인프라 a/b ─── 확장 c/d' 한 줄 (막대 = 인프라 완료 비율). 펼치면 두 체크리스트. */
function RoadmapLine({ setup, expansion }: { setup: RoadmapItem[]; expansion: RoadmapItem[] }) {
  const s = roadmapCount(setup);
  const e = roadmapCount(expansion);
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0;
  return (
    <details className="mt-2" data-testid="orch-roadmap">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2.5 text-[13px] text-text-muted">
        <span className="shrink-0 tabular-nums"><b className="font-semibold text-text">인프라</b> {s.text}</span>{" "}
        <span className="block h-1 flex-1 overflow-hidden rounded-sm bg-border" role="progressbar" aria-label="인프라 완료 항목" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={s.done}>
          <span className="block h-full bg-text" style={{ width: `${pct}%` }} />
        </span>{" "}
        <span className="shrink-0 tabular-nums"><b className="font-semibold text-text">확장</b> {e.text}</span>
        <ChevronIcon className="h-4 w-4" />
      </summary>
      <div className="pb-2">
        <RoadmapList title="인프라" items={setup} testid="orch-roadmap-setup" />
        <RoadmapList title="확장" items={expansion} testid="orch-roadmap-expansion" />
      </div>
    </details>
  );
}

const itemNumber = (item: BoardItem) => item.run?.number ?? Number(item.key.split("-")[1]);
const subTitle = (sub: string) => LIFECYCLE.flatMap((s) => s.sub).find((x) => x.id === sub)?.title ?? "";
const subK = (sub: string) => Number(sub.split(".")[1] ?? 0);

/**
 * One item in an open stage row (연한 파랑 카드): '#번호 제목' + 열기, '지금 S.K 세부이름 · Step k/N'.
 * A run also shows the whole-flow bar (검토·계획·개발·통합 = 6:9:16:8), '전체 39과정 중 …' and its steps (RunDetails).
 */
function ItemCard({ item, repo }: { item: BoardItem; repo: string }) {
  const r = item.run;
  const number = itemNumber(item);
  const step = r && typeof r.step === "number" && r.step > 0 ? `Step ${r.step}/${r.total}` : null;
  const now = [`지금 ${item.sub} ${subTitle(item.sub)}`, r ? step : item.label].filter(Boolean).join(" · ");
  const prog = r ? itemProgress(item.sub) : null;
  const testid = r ? `orch-run-${short(repo)}-${r.number}` : `orch-${item.kind}-${short(repo)}-${number}`;
  return (
    <div className="ml-[22px] mt-2.5 rounded-xl bg-accent-dim px-3.5 py-3 text-sm" data-testid={testid}>
      <div className="flex items-start justify-between gap-2">
        <b className="min-w-0 break-words font-semibold">#{number} {item.title}</b>
        <a href={item.url} target="_blank" rel="noreferrer" className="-my-3 inline-flex min-h-11 shrink-0 items-center text-[13px] font-semibold text-accent">열기</a>
      </div>
      <p className="mt-[3px] text-xs tabular-nums text-text-muted">{now}</p>
      {(r?.needsUser || item.blocked) && (
        <p className="mt-1.5 flex flex-wrap gap-1.5">
          {r?.needsUser && <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn">사용자 확인 필요</span>}
          {item.blocked && <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger"><StopIcon className="h-3 w-3" />멈춤</span>}
        </p>
      )}
      {prog && (
        <>
          <div className="mt-2.5 grid gap-[3px]" style={{ gridTemplateColumns: prog.parts.map((p) => `${p.count}fr`).join(" ") }}
            role="progressbar" aria-label="전체 과정" aria-valuemin={0} aria-valuemax={prog.total} aria-valuenow={prog.done}>
            {prog.parts.map((p) => (
              <span key={p.n} className="block h-1.5 overflow-hidden rounded-[3px] bg-[#D5DEEE]">
                <span className="block h-full bg-accent" style={{ width: `${Math.round((p.done / p.count) * 100)}%` }} />
              </span>
            ))}
          </div>
          <div className="mt-[3px] grid gap-[3px] text-[10.5px] text-text-muted" style={{ gridTemplateColumns: prog.parts.map((p) => `${p.count}fr`).join(" ") }} aria-hidden="true">
            {prog.parts.map((p) => <span key={p.n}>{p.title}</span>)}
          </div>
          <p className="mt-[3px] text-xs font-semibold tabular-nums" data-testid="orch-item-total">
            전체 {prog.total}과정 중 {prog.done} 완료 · 남은 {prog.remaining}{prog.left.length ? ` (${prog.left.map((x) => `${x.title} ${x.n}`).join(" · ")})` : ""}
          </p>
        </>
      )}
      {r && (
        <details className="mt-1" data-testid={`orch-run-steps-${short(repo)}-${r.number}`}>
          <summary className={`${SUMMARY} text-xs font-semibold text-accent`}>스텝 보기<ChevronIcon className="h-3.5 w-3.5 text-accent" /></summary>
          <RunDetails r={r} />
        </details>
      )}
    </div>
  );
}

/**
 * The stage's process (LIFECYCLE subs, 2 columns): done = blue check, where an item sits now = blue dot + bold + '#번호' tag,
 * still to do = hollow gray circle. A stage with no items has nothing left there, so every sub shows as done.
 */
function StageProcess({ c }: { c: BoardColumn }) {
  const step = LIFECYCLE[c.n - 1];
  const at = new Map<string, number[]>();
  for (const i of c.items) at.set(i.sub, [...(at.get(i.sub) ?? []), itemNumber(i)]);
  const empty = c.items.length === 0;
  const passed = empty ? Infinity : Math.min(...c.items.map((i) => subK(i.sub)));
  return (
    <ol className="ml-[22px] mt-2.5 grid grid-flow-col grid-cols-2 gap-x-2.5" style={{ gridTemplateRows: `repeat(${Math.ceil(step.sub.length / 2)}, auto)` }}
      aria-label={`${step.title} 세부 과정`} data-testid={`orch-stage-process-${c.n}`}>
      {step.sub.map((x) => {
        const here = at.get(x.id);
        const done = !here && subK(x.id) < passed;
        return (
          <li key={x.id} data-state={here ? "now" : done ? "done" : "todo"} className={`relative py-[3px] pl-[18px] text-[12.5px] ${here ? "font-bold text-text" : done ? "text-text-muted" : "text-text"}`}>
            {done ? (
              <svg aria-label="완료" role="img" viewBox="0 0 16 16" className="absolute left-0 top-[6px] h-3 w-3 text-accent" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8.5l3.2 3L13 4.5" /></svg>
            ) : here ? (
              <span aria-label="지금" role="img" className="absolute left-[1px] top-[7px] h-2.5 w-2.5 rounded-full bg-accent" />
            ) : (
              <span aria-label="남음" role="img" className="absolute left-[1px] top-[7px] h-2.5 w-2.5 rounded-full border-[1.5px] border-text-faint" />
            )}
            <span className="text-[10.5px] font-normal tabular-nums text-text-muted">{x.id}</span> {x.title}
            {here?.map((n) => <span key={n} className="ml-[3px] rounded-md bg-accent px-[5px] py-px text-[10.5px] text-white">#{n}</span>)}
          </li>
        );
      })}
    </ol>
  );
}

const issueLink = (repo: string, n: number) => (
  <a href={`https://github.com/${repo}/issues/${n}`} target="_blank" rel="noreferrer"
    className="-my-3 inline-flex min-h-11 items-center tabular-nums text-accent">#{n}</a>
);

/** 단계 줄 안 phase 묶음: '{id} {title}' 머리 · 세부 할 일(항목 줄) · tasks(나/AI 칩). 묶음 사이 얇은 구분. */
function PhaseGroupView({ g, colN, repo }: { g: PhaseGroup; colN: number; repo: string }) {
  const p = g.phase;
  const upcoming = p !== null && g.items.length === 0;
  return (
    <li className="border-t border-border py-2 first:border-t-0" data-testid={`orch-phase-group-${colN}-${p ? p.id : "none"}`} data-status={p?.status}>
      <p className={`flex flex-wrap items-baseline gap-x-1.5 text-[13px] ${p?.status === "doing" ? "font-semibold" : "font-medium"}`}>
        {p ? <><span className="font-normal tabular-nums text-text-muted">{p.id}</span><span className="min-w-0 break-words">{p.title}</span></>
          : <span className="text-text-muted">단계 미지정</span>}
        {upcoming && <span className="text-xs font-normal text-text-muted">예정</span>}
      </p>
      {g.items.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 text-xs">
          {g.items.map((item) => (
            <li key={item.key} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5" data-testid={`orch-phase-item-${itemNumber(item)}`}>
              <span className="shrink-0 text-text-muted">{item.label}</span>
              {item.kind === "idea" ? <span className="tabular-nums">#{itemNumber(item)}</span> : issueLink(repo, itemNumber(item))}
              <span className="min-w-0 break-words">{item.title}</span>
              {item.blocked && <span className="inline-flex items-center gap-1 text-danger"><StopIcon className="h-3 w-3" />멈춤</span>}
            </li>
          ))}
        </ul>
      )}
      {g.tasks.length > 0 && (
        <ul className="mt-0.5 space-y-0.5 text-xs" data-testid="orch-phase-tasks">
          {g.tasks.map((t, i) => (
            <li key={i} className="flex min-w-0 items-baseline gap-1.5">
              <span className={`shrink-0 rounded-full px-1.5 py-px text-[11px] font-medium ${t.owner === "me" ? "bg-warn/10 text-warn" : "bg-bg text-text-muted"}`}>{t.owner === "me" ? "나" : "AI"}</span>
              <span className="min-w-0 break-words">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** 통합 줄 아래 '완료' 줄(단계 번호 없음, 기본 접힘): 끝난 phase '{id} {title}' + 끝난 run 번호 링크. */
function DoneRow({ done, repo }: { done: DonePhase[]; repo: string }) {
  return (
    <details className="group border-t border-border" data-testid="orch-stage-done">
      <summary className="flex min-h-11 cursor-pointer items-baseline gap-2 py-[13px] text-[15px]">
        <b className="shrink-0 font-bold">완료</b>{" "}
        <span className="ml-auto shrink-0 font-bold tabular-nums"><span className="sr-only"> · </span>{done.length}</span>
        <ChevronIcon className="h-4 w-4 self-center" />
      </summary>
      <ul className="ml-[22px] pb-3 text-[13px]">
        {done.map(({ phase, runs }) => (
          <li key={phase.id} className="flex flex-wrap items-baseline gap-x-1.5 border-t border-border py-1.5 first:border-t-0" data-testid={`orch-done-phase-${phase.id}`}>
            <span className="tabular-nums text-text-muted">{phase.id}</span>
            <span className="min-w-0 break-words">{phase.title}</span>
            {runs.map((n) => <span key={n} className="text-xs">{issueLink(repo, n)}</span>)}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** One stage row ('번호 단계 · #번호 상태 · 개수'), collapsed by default (card height limit); opening it shows desc, process, items (phase groups when `pc`). */
function StageRow({ c, repo, pc }: { c: BoardColumn; repo: string; pc?: PhaseColumn }) {
  const needs = boardNeedsUser(c);
  const empty = c.items.length === 0 && !(pc && pc.groups.length > 0);
  const note = c.items.length === 0 ? (empty ? "지금 없음" : "예정 단계") : `${c.items.map((i) => `#${itemNumber(i)}`).join(" · ")} ${c.items[0].label}`;
  return (
    <details className="group border-t border-border" data-testid={`orch-stage-${c.n}`}>
      <summary className="flex min-h-11 cursor-pointer items-baseline gap-2 py-[13px] text-[15px]">
        <span className="w-3.5 shrink-0 text-[13px] font-semibold tabular-nums text-text-muted">{c.n}</span>{" "}
        <b className="shrink-0 font-bold">{c.title}</b>{" "}
        <small className="min-w-0 truncate text-xs text-text-muted group-open:hidden">{note}</small>{" "}
        {needs > 0 && <span className="shrink-0 self-center rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-medium text-warn">확인 필요 {needs}</span>}
        <span className={`ml-auto shrink-0 tabular-nums ${empty ? "font-medium text-text-faint" : "font-bold"}`}><span className="sr-only"> · </span>{c.items.length}</span>
        <ChevronIcon className="h-4 w-4 self-center" />
      </summary>
      <div className="pb-3">
        <p className="ml-[22px] text-xs text-text-muted">{LIFECYCLE[c.n - 1].desc}</p>
        <StageProcess c={c} />
        {empty && <p className="ml-[22px] mt-2 text-xs text-text-muted">이 단계에서 남은 일 없음</p>}
        {pc ? (
          <ul className="ml-[22px] mt-2" data-testid={`orch-phase-groups-${c.n}`}>
            {pc.groups.map((g) => <PhaseGroupView key={g.phase?.id ?? "none"} g={g} colN={c.n} repo={repo} />)}
          </ul>
        ) : c.items.map((item) => <ItemCard key={item.key} item={item} repo={repo} />)}
      </div>
    </details>
  );
}

/** Stage cell: big '남은 과정' (largest among its items) + small '/세부 개수'; no items → 0 (nothing left there). 0 is gray. */
function StageCell({ c, phaseCount }: { c: BoardColumn; phaseCount?: number }) {
  const n = columnRemaining(c);
  return (
    <div className="rounded-xl bg-bg px-2 py-2.5" data-testid={`orch-cell-${c.n}`}>
      <span className="block text-xs text-text-muted">{c.title}</span>
      <b className={`text-xl font-bold tabular-nums ${n ? "text-text" : "text-text-faint"}`}>
        {n ?? 0}<small className="ml-0.5 text-[13px] font-medium text-text-faint">/{LIFECYCLE[c.n - 1].sub.length}</small>
      </b>
      {phaseCount ? <span className="block text-[11px] tabular-nums text-text-muted" data-testid={`orch-cell-phases-${c.n}`}>{phaseCount}단계</span> : null}
    </div>
  );
}

/**
 * 프로젝트 카드. 머리(저장소 이름 · [단계 a/b 완료] · 남은 할 일 · 확인 필요)는 접기 버튼이고, 본문([진행 단계] · 남은 할 일 요약 · 칸 · 인프라/확장 · 단계 줄)이 접힌다.
 * [ ] 는 roadmap.json 'phases' 가 있을 때만.
 * 다른 프로젝트는 roadmap.json 'app' 이 있으면 머리 오른쪽에 '화면 열기' 링크 (버튼 밖, 새 탭). 자기 저장소(isSelf, 서버 판정)는 링크 없음.
 */
function ProjectCard({ v, open, onToggle }: { v: RepoView; open: boolean; onToggle: () => void }) {
  const bodyId = useId();
  const board = stageBoard({ runs: v.runs, plans: v.plans ?? [], ideas: v.ideas ?? [] });
  const needs = board.reduce((n, c) => n + boardNeedsUser(c), 0);
  const app = !v.isSelf ? v.roadmap?.app ?? null : null;
  // 검토(아이디어)는 개발할지 정하기 전이라 본 흐름(계획·개발·통합)과 따로 보인다
  const flow = board.filter((c) => c.n > 1);
  const review = board[0];
  const left = boardRemaining(flow);
  // 직접 할 일: 인프라 체크리스트 중 아직 안 끝난 것 (사람이 확인·설정할 항목, 확장은 제외)
  const todo = (v.roadmap?.setup ?? []).filter((i) => i.status === "doing" || i.status === "todo");
  // 진행 단계: roadmap.json 'phases' + 연결된 run 상태로 자동 완료/진행 (없으면 화면은 그대로)
  const phases = phaseStatus(v.roadmap?.phases ?? [], v.runs);
  const phaseCount = roadmapCount(phases);
  const pb = phases.length > 0 ? phaseBoard(board, phases, v.runs) : null;
  const roadmapNote = v.roadmapError ? `로드맵 읽기 실패 · ${v.roadmapError}` : !v.roadmap ? "로드맵 없음(docs/roadmap.json)" : null;
  return (
    <Card>
      <section aria-label={`${short(v.repo)} 작업`} data-testid={`orch-project-${short(v.repo)}`}>
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 flex-1">
            <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} data-testid="orch-project-toggle"
              className="flex min-h-11 w-full items-center gap-1.5 rounded-lg text-left">
              <span className="min-w-0">
                <span className="block truncate text-lg font-bold tracking-[-0.02em]">{short(v.repo)}</span>
                <span className={`block text-xs tabular-nums text-text-muted${phases.length > 0 ? " break-keep" : ""}`} data-testid="orch-project-summary">
                  {phases.length > 0 && `단계 ${phaseCount.done}/${phaseCount.total} 완료 · `}
                  {left === null ? "남은 할 일 없음" : `남은 할 일 ${left}과정`}
                  {needs > 0 && <> · <span className="font-semibold text-warn">확인 필요 {needs}</span></>}
                </span>
              </span>
              <ChevronIcon className={`ml-auto h-4 w-4 ${open ? "rotate-90" : ""}`} />
            </button>
          </h3>
          <div className="flex shrink-0 flex-col items-end text-xs tabular-nums text-text-muted">
            {app && (
              <a href={app.url} target="_blank" rel="noreferrer" data-testid="orch-app-link"
                className="inline-flex min-h-11 max-w-[9.5rem] items-center gap-0.5 font-semibold text-accent">
                <span className="truncate">{app.label ? `${app.label} 열기` : "화면 열기"}</span><ArrowRightIcon className="h-3 w-3 shrink-0" />
              </a>
            )}
            <span className={app ? "" : "pt-1.5"} data-testid="orch-deploy-pending">
              배포 대기 {v.deployPending ?? "?"} ·{" "}
              <Link href="/patch-notes" className="-my-3 inline-flex min-h-11 items-center gap-0.5 text-accent">완료 기록<ArrowRightIcon className="h-3 w-3" /></Link>
            </span>
          </div>
        </div>
        <div id={bodyId} hidden={!open} data-testid="orch-project-body">
        <p className="mt-3 text-[13px] tabular-nums text-text-muted" data-testid="orch-remaining">
          {left === null ? "개발 남은 일 없음" : <>남은 할 일 <b className="font-semibold text-text">{left}과정</b> · 단계별</>}
          {todo.length > 0 && <> · 직접 할 일 <b className="font-semibold text-text">{todo.length}건</b></>}
        </p>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {flow.map((c) => <StageCell key={c.n} c={c} phaseCount={pb?.columns.find((x) => x.n === c.n)?.groups.filter((g) => g.phase).length} />)}
        </div>
        {todo.length > 0 && (
          <div className="mt-3 rounded-xl bg-warn/10 px-3 py-2" data-testid="orch-todo">
            <p className="text-xs font-semibold text-warn">직접 할 일 {todo.length}</p>
            <ul className="mt-1 space-y-1">
              {todo.map((i) => (
                <li key={i.id} className="grid grid-cols-[0.875rem_1fr] gap-x-1.5 text-[12.5px]">
                  <span aria-hidden="true" className="mt-[5px] h-2.5 w-2.5 rounded-full border-[1.5px] border-warn" />
                  <span className="min-w-0"><span className="tabular-nums text-text-muted">{i.id}</span> {i.title}{i.note && <span className="block text-[11.5px] text-text-muted">{i.note}</span>}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {roadmapNote ? <p className={`mt-3 text-xs ${v.roadmapError ? "text-danger" : "text-text-muted"}`} data-testid="orch-roadmap-note">{roadmapNote}</p>
          : <RoadmapLine setup={v.roadmap!.setup} expansion={v.roadmap!.expansion} />}
        <section aria-label="작업 흐름" className="mt-2" data-testid="orch-flow">
          {v.runsError && <p className="pb-1 text-xs text-danger">작업 불러오기 실패 · {v.runsError}</p>}
          {v.plansError && <p className="pb-1 text-xs text-danger">계획 불러오기 실패 · {v.plansError}</p>}
          {v.ideasError && <p className="pb-1 text-xs text-danger">아이디어 불러오기 실패 · {v.ideasError}</p>}
          {flow.map((c) => <StageRow key={c.n} c={c} repo={v.repo} pc={pb?.columns.find((x) => x.n === c.n)} />)}
          {pb && <DoneRow done={pb.done} repo={v.repo} />}
        </section>
        <section aria-label="추가 검토" className="mt-4" data-testid="orch-review">
          <p className="pb-1 text-xs font-semibold text-text-muted">추가 검토 · 개발 여부를 정하기 전 아이디어 <span className="tabular-nums">{review.items.length}건</span></p>
          <StageRow c={review} repo={v.repo} />
        </section>
        </div>
      </section>
    </Card>
  );
}

/** 프로젝트 탭: 프로젝트마다 남은 할 일 · 3칸(계획·개발·통합) · 인프라/확장 한 줄 · 단계 줄 3개 · 추가 검토(아이디어) 줄 (모두 접고 펼 수 있음). */
const AGENT_NAME: Record<AgentId, string> = { sonnet: "Sonnet", opus: "Opus", codex: "Codex", user: "사용자" };

/** AI 팀 탭 맨 위: 지금 어떤 AI가 어떤 일을 맡고 있는지 (엔진과 같은 규칙으로 화면에서 계산). 작업 제목·상태만 보인다. */
function ActiveAgentsCard({ repos }: { repos: RepoView[] }) {
  const rows = activeAgents(repos.flatMap((v) => v.runs), Object.fromEntries(repos.map((v) => [v.repo, v.switches])));
  return (
    <Card>
      <h2 className={CARD_TITLE}>지금 일하는 AI</h2>
      <ul className="mt-2 text-sm" data-testid="orch-agents">
        {rows.map((row) => (
          <li key={row.agent} className={`${ROW} first:border-t-0`} data-testid={`orch-agent-${row.agent}`}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="shrink-0 font-semibold">{AGENT_NAME[row.agent]}</span>
              {row.off ? <span className="text-text-muted">OFF</span>
                : !row.items.length && <span className="text-text-muted">쉬는 중</span>}
            </div>
            {!row.off && row.items.map((it) => (
              <p key={`${it.repo}#${it.number}`} className={`flex min-w-0 items-center gap-1 text-[13px] ${row.agent === "user" ? "text-warn" : "text-text-muted"}`}>
                <span className="shrink-0">{short(it.repo)} ·</span>
                <a href={it.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 min-w-0 items-center gap-1 underline">
                  <span className="shrink-0">#{it.number}</span><span className="truncate">{it.goal}</span>
                </a>
                <span className="shrink-0">· {it.step ? `Step ${it.step}/${it.total} ` : ""}{it.activity}</span>
              </p>
            ))}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function OrchAgentsNowPanel() {
  const { state } = useOrch();
  if (state.kind !== "ok") return <section aria-label="지금 일하는 AI" className="space-y-2"><h2 className={SECTION_TITLE}>지금 일하는 AI</h2><Card><StateNote kind={state.kind} /></Card></section>;
  return <ActiveAgentsCard repos={state.data.repos} />;
}

export function OrchRunsPanel({ pmChatUrl }: { pmChatUrl?: string } = {}) {
  const { state, reload, error } = useOrch();
  const latest = useRef({ state, error }); latest.current = { state, error };
  const [busy, setBusy] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  // 프로젝트 카드 접힘: 기본은 모두 펼침, 저장소별로 localStorage 에 기억 (읽기·쓰기 실패 시 기본값)
  const [collapsed, setCollapsed] = useState<string[]>([]);
  useEffect(() => { setCollapsed(readCollapsed(() => window.localStorage)); }, []);
  function toggleProject(repo: string) {
    setCollapsed((prev) => {
      const next = toggleCollapsed(prev, repo);
      writeCollapsed(() => window.localStorage, next);
      return next;
    });
  }
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
  const meta = updatedAt !== null ? `방금 갱신 ${formatKstTime(updatedAt)}`
    : state.kind === "ok" && state.data.generatedAt ? `${formatKstShort(state.data.generatedAt)} 갱신`
    : "실제 GitHub 기록 기준";
  return (
    <>
      <PageTitle title="AI Orchestrator" subtitle={meta} subtitleTestId={updatedAt !== null ? "orch-refreshed" : "orch-generated"} actions={<>
        <button type="button" onClick={refresh} disabled={busy} aria-label="새로고침" aria-busy={busy} title={busy ? "불러오는 중…" : "새로고침"} data-testid="orch-refresh" className={ICON_BUTTON}>
          <RefreshIcon className={`h-[18px] w-[18px] ${busy ? "motion-safe:animate-spin" : ""}`} />
        </button>
        {pmChatUrl && <a href={pmChatUrl} target="_blank" rel="noreferrer" className={PRIMARY_BUTTON}>PM에게 말하기</a>}
      </>} />
      <section aria-label="자동 진행 작업" className="space-y-3" data-testid="orch-runs">
        {failed && <p role="status" className="px-1 text-xs text-danger">새로고침 실패 · 잠시 후 다시</p>}
        {state.kind !== "ok" ? <Card><StateNote kind={state.kind} /></Card> : <>
          {state.data.repos.map((v) => <ProjectCard key={v.repo} v={v} open={!collapsed.includes(v.repo)} onToggle={() => toggleProject(v.repo)} />)}
        </>}
      </section>
    </>
  );
}

const BADGE_TONE: Record<PlanBadgeTone, string> = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  muted: "bg-unknown/10 text-text-muted",
};

function PlanCard({ p, canApprove, busy, armed, onArm, onApprove }: { p: PendingPlan; canApprove: boolean; busy: boolean; armed: boolean; onArm(): void; onApprove(): void }) {
  const badge = planReviewBadge(p.review);
  return (
    <div className={`${ROW} pb-1 text-sm`} data-testid={`orch-plan-${short(p.repo)}-${p.number}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-semibold">{p.goal}</p>
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${BADGE_TONE[badge.tone]}`}>{badge.tone === "ok" ? <CheckIcon className="h-3 w-3" /> : badge.revise ? <EditIcon className="h-3 w-3" /> : badge.tone === "danger" ? <AlertIcon className="h-3 w-3" /> : null}{badge.text}</span>
      </div>
      <p className="mt-[3px] text-xs tabular-nums text-text-muted">{short(p.repo)} #{p.number} · 스텝 {p.steps}개</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {canApprove && (
          <button type="button" disabled={busy} onClick={armed ? onApprove : onArm}
            className={armed ? "inline-flex min-h-11 items-center rounded-xl bg-warn/15 px-3 text-[13px] font-semibold text-warn disabled:opacity-50" : BUTTON}>
            {busy ? "승인 중…" : armed ? "정말 시작할까요? 승인" : "승인"}
          </button>
        )}
        {canApprove && badge.revise && <span className="text-xs text-warn">감사에서 수정 필요 상태입니다</span>}
        <a href={p.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-[13px] font-semibold text-accent">계획 보기</a>
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

  const status = msg && <p role="status" className={STATUS_BOX}>{msg}</p>;
  const errorLines = errors.map((v) => <p key={v.repo} className="text-xs text-danger">{short(v.repo)} 계획 불러오기 실패 · {v.plansError}</p>);
  if (!plans.length) return <Card><div className="space-y-2" data-testid="orch-plans">{status}{errorLines}<p className="text-sm text-text-muted">승인 대기 계획 없음</p></div></Card>;
  return (
    <Card>
      <section aria-label="승인 대기 계획" className="space-y-2" data-testid="orch-plans">
        <h2 className={CARD_TITLE}>승인 대기 계획 <span className="font-medium tabular-nums text-text-muted">· {plans.length}</span></h2>
        {status}
        {errorLines}
        <div>
          {plans.map((p) => {
            const key = `${p.repo}#${p.number}`;
            return <PlanCard key={key} p={p} canApprove={canApprove} busy={busy !== null} armed={armed === key} onArm={() => { setArmed(key); setMsg(null); }} onApprove={() => approve(p)} />;
          })}
        </div>
        {!canApprove && <p className="text-xs text-text-muted">{session.role !== "admin" ? "관리자 로그인에서만 승인할 수 있습니다." : "서버에 쓰기 토큰(ORCH_GITHUB_TOKEN)이 없어 승인할 수 없습니다."}</p>}
      </section>
    </Card>
  );
}

/** 카드 밖 구역 제목 (AI 사용량 · AI ON/OFF). */
const SECTION_TITLE = "px-1 text-lg font-[750] tracking-[-0.02em]";

/** PM 브리핑 탭: 사용자 판단이 필요한 작업만. */
export function OrchDecisionsPanel() {
  const { state } = useOrch();
  if (state.kind !== "ok") return <Card><section aria-label="엔진 결정 필요" className="space-y-2"><h2 className={CARD_TITLE}>엔진 · 결정 필요</h2><StateNote kind={state.kind} /></section></Card>;
  const runs = state.data.repos.flatMap((v) => v.runs).filter((r) => r.needsUser || r.held);
  return (
    <Card>
      <section aria-label="엔진 결정 필요" data-testid="orch-decisions">
        <h2 className={CARD_TITLE}>엔진 · 결정 필요 <span className="font-medium tabular-nums text-text-muted">· {runs.filter((r) => r.needsUser).length}</span></h2>
        {runs.length > 0 && <div className="mt-2 -mb-3">{runs.map((r) => <RunCard key={`${r.repo}#${r.number}`} r={r} />)}</div>}
        {!runs.length && <p className="mt-2 text-sm text-text-muted">없음 — 모든 작업이 자동으로 진행 중입니다.</p>}
      </section>
    </Card>
  );
}

const FLAG_TEXT: Record<FlagKey, { name: string; off: string }> = {
  sonnet: { name: "Claude Sonnet (구현)", off: "Opus가 대신 구현" },
  opus: { name: "Claude Opus (고난도 구현·대체 검수)", off: "Sonnet이 대신 구현, 대체 검수 없음" },
  codex: { name: "Codex (독립 검수)", off: "Opus가 바로 검수" },
  codexDev: { name: "Codex 개발 대체 (Claude 한도일 때)", off: "Claude 한도가 풀릴 때까지 대기" },
  paused: { name: "전체 일시정지", off: "" },
  auto: { name: "자동 모드 (시작·반영 자동)", off: "계획 시작(orch:go)과 위험 변경 반영은 사람이 함" },
};

/** AI 팀 탭: 스위치 한 벌을 등록된 모든 프로젝트에 한 번에 적용(POST scope all). 관리자 세션에서만 조작 가능. */
export function OrchSwitchesPanel() {
  const { state, reload } = useOrch();
  const session = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<SwitchMessage | null>(null);
  const aligning = useRef(false); // '모두 맞추기' 중복 실행 막기 (상태 갱신 전 두 번 눌러도 한 번만)
  const canEdit = session.role === "admin" && state.kind === "ok" && state.data.canWrite;
  const merged = state.kind === "ok" ? mergedSwitches(state.data.repos) : null;
  const value = merged?.value ?? null;
  const locked = !canEdit || busy !== null || !value;
  const differs = merged ? differsText(merged.differs) : null;

  async function postAll(key: SwitchKey, v: boolean | string): Promise<SwitchAllResponse> {
    try {
      const r = await fetch("/api/orch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify({ key, value: v, scope: "all" }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    } catch { return { status: 0, body: null }; }
  }

  async function change(key: SwitchKey, v: boolean | string) {
    if (locked) return;
    setBusy(key); setMsg(null);
    try { setMsg(switchResultMessage(await postAll(key, v))); await reload(); }
    finally { setBusy(null); }
  }

  async function alignAll() {
    if (locked || !value || !merged?.differs.length || aligning.current) return;
    aligning.current = true; setBusy("align"); setMsg(null);
    try { setMsg(alignResultMessage(await alignSwitches(value, merged.differs, postAll))); await reload(); }
    finally { aligning.current = false; setBusy(null); }
  }

  return (
    <section aria-label="엔진 ON/OFF" className="space-y-2" data-testid="orch-switches">
      <h2 className={SECTION_TITLE}>AI ON/OFF</h2>
      <p className="px-1 text-xs text-text-muted">끄면 새 작업만 막고, 이미 실행 중인 작업은 끝까지 진행합니다. GitHub 저장소 변수에 저장되어 이 앱이 꺼져 있어도 지켜집니다.</p>
      {msg && <p role="status" className={`${STATUS_BOX} ${msg.tone === "warn" ? "text-warn" : ""}`} data-testid="orch-switch-msg">{msg.text}</p>}
      {differs && (
        <div className="flex items-center gap-2 px-1" data-testid="orch-switch-differs">
          <p className="min-w-0 flex-1 text-xs text-warn">{differs}</p>
          <button type="button" onClick={alignAll} disabled={locked} className={`${BUTTON} shrink-0`}>{busy === "align" ? "맞추는 중…" : "모두 맞추기"}</button>
        </div>
      )}
      {merged && merged.unreadable.length > 0 && <p className="px-1 text-xs text-text-muted" data-testid="orch-switch-unreadable">읽지 못함: {merged.unreadable.map(short).join(", ")}</p>}
      {state.kind !== "ok" ? <Card><StateNote kind={state.kind} /></Card> : (
        <div data-testid="orch-switch-card">
          <Card>
            <h3 className={CARD_TITLE}>모든 프로젝트</h3>
            <p className="mt-[3px] text-xs text-text-muted">등록된 모든 프로젝트에 한 번에 적용</p>
            {!value && <p className="mt-2 text-xs text-danger">스위치를 읽지 못했습니다</p>}
            <div className="mt-2">
              {FLAG_KEYS.map((k) => {
                const on = value?.[k] ?? false;
                const label = !value ? "—" : k === "paused" ? (on ? "정지됨" : "운영 중") : on ? "ON" : "OFF";
                const active = !!value && (k === "paused" ? !on : on);
                return (
                  <div key={k} className={`flex items-center justify-between gap-3 ${ROW} py-2`}>
                    <div className="min-w-0"><p className="text-sm font-medium">{FLAG_TEXT[k].name}</p>{value && !active && FLAG_TEXT[k].off && <p className="mt-[3px] text-xs text-text-muted">꺼짐 · {FLAG_TEXT[k].off}</p>}</div>
                    <button type="button" role="switch" aria-checked={active} aria-label={FLAG_TEXT[k].name} disabled={locked}
                      onClick={() => change(k, !on)}
                      className={`min-h-11 min-w-20 shrink-0 rounded-full px-3 text-[13px] font-semibold disabled:opacity-50 ${active ? "bg-accent text-white" : "bg-bg text-text-muted ring-1 ring-inset ring-border"}`}>
                      {busy === k ? "…" : label}
                    </button>
                  </div>
                );
              })}
              <WindowEditor id="win-all" value={value?.window ?? ""} disabled={locked} onSave={(w) => change("window", w)} />
            </div>
          </Card>
        </div>
      )}
      {state.kind === "ok" && !canEdit && <p className="px-1 text-xs text-text-muted">{session.role !== "admin" ? "관리자 로그인에서만 바꿀 수 있습니다." : WRITE_UNCONFIGURED_TEXT}</p>}
    </section>
  );
}

/** 작업 시간대 입력. 기준값(value)이 바뀌면(저장 뒤 다시 읽기 등) 입력값도 새 기준값으로 맞춘다. */
function WindowEditor({ id, value, disabled, onSave }: { id: string; value: string; disabled: boolean; onSave(v: string): void }) {
  const [w, setW] = useState(value);
  useEffect(() => { setW(value); }, [value]);
  return (
    <div className={`space-y-1.5 ${ROW} pb-0`}>
      <label className="block text-sm font-medium" htmlFor={id}>작업 시간대 (한국시간, 비우면 항상)</label>
      <div className="flex gap-2">
        <input id={id} value={w} onChange={(e) => setW(e.target.value)} placeholder="08:00-24:00" inputMode="numeric" data-testid="orch-window-input"
          className={`${FIELD} min-h-11 min-w-0 flex-1 tabular-nums`} />
        <button type="button" disabled={disabled || w.trim() === value} onClick={() => onSave(w.trim())} className={BUTTON}>저장</button>
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
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-text-muted">{label}</span>
        <span className={`font-semibold tabular-nums ${p === null ? "text-text-muted" : ""}`}>{p === null ? "확인 불가" : `${p}% 사용 · ${left}% 남음`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-border"><div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, p ?? 0)}%` }} /></div>
      <p className="text-[11px] tabular-nums text-text-muted">리셋 {w?.resetsAt ? formatKst(w.resetsAt) : "확인 불가"}</p>
    </div>
  );
}

/** AI 팀 탭: 구독 사용량 (계정 전체 기준, orch:usage 스냅샷). */
export function OrchUsagePanel() {
  const { state, reload } = useOrch();
  const session = useSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (state.kind !== "ok") return <section aria-label="AI 사용량" className="space-y-2"><h2 className={SECTION_TITLE}>AI 사용량</h2><Card><StateNote kind={state.kind} /></Card></section>;
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
        <h2 className={SECTION_TITLE}>AI 사용량</h2>
        {canRefresh && <button type="button" onClick={refresh} disabled={busy} data-testid="usage-refresh" className={BUTTON}>{busy ? "요청 중…" : <><RefreshIcon className="h-4 w-4" />지금 확인</>}</button>}
      </div>
      {msg && <p role="status" className={STATUS_BOX}>{msg}</p>}
      {u && state.data.repos.some((r) => r.usageRefresh === "requested" || r.usageRefresh === "running") && <p className="px-1 text-[11px] text-text-muted" data-testid="usage-refreshing">값이 1시간 넘게 지나 새로 확인하는 중입니다. 1~2분 뒤 새로고침하면 반영됩니다.</p>}
      {!u ? <Card><p className="text-sm text-text-muted">아직 사용량 기록이 없습니다. 엔진의 usage 작업이 처음 돌면 표시됩니다.</p></Card> : <>
        <Card className="space-y-3">
          <h3 className={CARD_TITLE}>Claude <span className="text-xs font-normal tracking-normal text-text-muted">구독 전체 · 직접 대화 포함</span></h3>
          {u.claude ? <><Bar label="5시간" w={u.claude.fiveHour} /><Bar label="7일" w={u.claude.sevenDay} /></> : <p className="text-sm text-text-muted">확인 불가{u.claudeError ? ` · ${u.claudeError}` : ""}</p>}
          <p className="border-t border-border pt-2.5 text-[11px] tabular-nums text-text-muted">확인 {formatKst(u.claudeCheckedAt, "없음")}{u.claude && u.claudeError ? ` · 이번 확인: ${u.claudeError}` : ""}</p>
        </Card>
        <Card className="space-y-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className={CARD_TITLE}>Codex</h3>
            {u.codex.limited && <span className="rounded-full bg-warn/10 px-2 py-0.5 text-xs font-medium text-warn">한도 소진 · Opus 대체 검수</span>}
          </div>
          {u.codex.fiveHour || u.codex.weekly ? <><Bar label="5시간" w={u.codex.fiveHour} /><Bar label="주간" w={u.codex.weekly} /></> : <p className="text-sm text-text-muted">사용률 확인 불가</p>}
          {u.codex.needsLogin && <p className="flex items-start gap-2 rounded-xl bg-warn/10 px-3.5 py-2.5 text-[13px] text-warn"><KeyIcon className="mt-0.5 h-4 w-4" /><span className="min-w-0">폰 로그인 필요 — GitHub Actions → codex-login → Run workflow 후 표시되는 코드로 승인</span></p>}
          <p className="border-t border-border pt-2.5 text-[11px] tabular-nums text-text-muted">확인 {formatKst(u.codex.checkedAt, "없음")}{u.codex.error && !u.codex.needsLogin ? ` · 이번 조회: ${u.codex.error}` : ""}</p>
        </Card>
      </>}
    </section>
  );
}
