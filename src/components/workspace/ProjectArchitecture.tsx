"use client";
// '구조' 탭: 프로젝트 카드 목록. 첫 카드는 자기 저장소(항상 보임, 정적 내용), 그 아래는 /api/architecture 로 읽은
// 다른 저장소의 docs/architecture.json. 카드는 기본 접힘, 펼침 상태는 localStorage 'orch.arch.open'.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Card, PageTitle } from "@/components/ui";
import { ChevronIcon } from "@/components/icons";
import { useAuthedJson } from "@/components/live/useAuthedJson";
import { Section, SelfArchitectureSections } from "./ArchitectureScreen";
import { boxLineCount, boxMaxChars, fitLine, readArchOpen, toggleArchOpen, writeArchOpen, ARCH_FONT, ARCH_LINE_H } from "@/lib/orch/archOpen";
import type { ArchBlock, ArchBox, Architecture } from "@/lib/orch/model";

export const SELF_NAME = "ai-orchestrator";
export const SELF_PURPOSE = "요청만 하면 AI 팀이 계획부터 반영까지 알아서 개발";

type ArchRepo = { repo: string; architecture: Architecture | null; error: string | null };
const short = (repo: string) => repo.split("/")[1] ?? repo;

// 색은 tailwind.config 의 토큰 값과 같다 (SVG 속성에는 클래스 대신 값을 쓴다).
const TONES: Record<ArchBox["tone"], { fill: string; stroke: string; text: string }> = {
  plain: { fill: "#FFFFFF", stroke: "#111418", text: "#111418" },
  accent: { fill: "#EEF3FD", stroke: "#2563D9", text: "#111418" },
  deep: { fill: "#111418", stroke: "#111418", text: "#FFFFFF" },
};

function Diagram({ block }: { block: Extract<ArchBlock, { type: "diagram" }> }) {
  const mid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const markerId = `arch-arrow-${mid}`;
  return (
    <div>
      <svg viewBox={`0 0 300 ${block.height}`} width="100%" role="img" aria-label={block.label} data-testid="arch-ext-diagram" style={{ display: "block" }} fontSize={ARCH_FONT}>
        <defs>
          <marker id={markerId} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M1 1l5 3-5 3" fill="none" stroke="#7A828E" strokeWidth="1.4" />
          </marker>
        </defs>
        {block.arrows.map((a, i) => (
          <polyline key={`a${i}`} points={a.points.map((p) => p.join(",")).join(" ")} fill="none" stroke="#7A828E" strokeWidth="1.2" markerEnd={`url(#${markerId})`} />
        ))}
        {block.boxes.map((b, i) => {
          const t = TONES[b.tone];
          const n = boxLineCount(b.h, b.lines.length);
          const max = boxMaxChars(b.w);
          const lines = b.lines.slice(0, n).map((l) => fitLine(l, max)).filter((l) => l !== "");
          const top = b.y + b.h / 2 - (lines.length * ARCH_LINE_H) / 2;
          return (
            <g key={`b${i}`}>
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={9} fill={t.fill} stroke={t.stroke} strokeWidth="1.2" />
              {lines.map((l, j) => (
                <text key={j} x={b.x + b.w / 2} y={top + j * ARCH_LINE_H + 10.5} textAnchor="middle" fill={t.text}>{l}</text>
              ))}
            </g>
          );
        })}
      </svg>
      {block.caption && <p className="mt-2 text-[11px] text-text-muted">{block.caption}</p>}
    </div>
  );
}

function Block({ block }: { block: ArchBlock }) {
  if (block.type === "text") {
    return (
      <Card>
        <ul className="space-y-1.5 text-[13px]">
          {block.lines.map((l, i) => (
            <li key={i} className="grid grid-cols-[0.75rem_1fr] gap-x-1.5"><span aria-hidden="true" className="mt-[7px] h-1 w-1 rounded-full bg-text-faint" /><span className="min-w-0 break-words">{l}</span></li>
          ))}
        </ul>
      </Card>
    );
  }
  if (block.type === "table") {
    return (
      <Card className="py-1.5">
        <table className="w-full table-fixed border-collapse text-left text-[12.5px]" data-testid="arch-ext-table">
          <thead>
            <tr>{block.head.map((h, i) => <th key={i} scope="col" className="break-words py-2 pr-2 align-top text-[11px] font-semibold text-text-muted">{h}</th>)}</tr>
          </thead>
          <tbody>
            {block.rows.map((r, i) => (
              <tr key={i} className="border-t border-border">
                {r.map((c, j) => <td key={j} className="break-words py-2 pr-2 align-top">{c}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    );
  }
  return <Card><Diagram block={block} /></Card>;
}

/** 프로젝트 카드: 머리(이름 + 목적/상태 문구)가 접기 버튼, 내용은 카드 밖 아래에 펼친다 (카드 안 카드 없음). */
function ProjectCard({ id, name, note, noteTone, open, onToggle, children, testId }: {
  id: string; name: string; note: string; noteTone: "muted" | "danger"; open: boolean; onToggle: () => void; children: ReactNode; testId: string;
}) {
  const bodyId = `${useId().replace(/[^a-zA-Z0-9]/g, "")}-arch-body`;
  return (
    <section aria-label={`${name} 구조`} data-testid={testId} data-arch-id={id}>
      <Card className="py-1.5">
        <h2>
          <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={bodyId} data-testid="arch-toggle"
            className="flex min-h-11 w-full items-center gap-1.5 rounded-lg py-1.5 text-left">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-lg font-bold tracking-[-0.02em]">{name}</span>
              <span className={`block break-words text-xs ${noteTone === "danger" ? "text-danger" : "text-text-muted"}`} data-testid="arch-note">{note}</span>
            </span>
            <ChevronIcon className={`h-4 w-4 ${open ? "rotate-90" : ""}`} />
          </button>
        </h2>
      </Card>
      <div id={bodyId} hidden={!open} data-testid="arch-body" className="mt-4">
        {open && children}
      </div>
    </section>
  );
}

function ExternalSections({ a }: { a: Architecture }) {
  return (
    <div className="space-y-7">
      {a.sections.map((s, i) => (
        <Section key={i} no={s.no} kicker={s.kicker} title={s.title}>
          {s.blocks.map((b, j) => <Block key={j} block={b} />)}
        </Section>
      ))}
    </div>
  );
}

export function LiveArchitectureScreen() {
  const { state } = useAuthedJson<{ repos: ArchRepo[] }>("/api/architecture", (status, body) => {
    const j = body as { repos?: unknown } | null;
    return status === 200 && j && Array.isArray(j.repos) ? (j as { repos: ArchRepo[] }) : null;
  });
  const [open, setOpen] = useState<string[]>([]);
  useEffect(() => { setOpen(readArchOpen(() => window.localStorage)); }, []);
  function toggle(id: string) {
    setOpen((prev) => {
      const next = toggleArchOpen(prev, id);
      writeArchOpen(() => window.localStorage, next);
      return next;
    });
  }
  return (
    <div className="space-y-3">
      <PageTitle title="구조" subtitle="프로젝트마다 어떻게 돌아가는지" />
      <ProjectCard id="self" name={SELF_NAME} note={SELF_PURPOSE} noteTone="muted" open={open.includes("self")} onToggle={() => toggle("self")} testId="arch-project-self">
        <SelfArchitectureSections />
      </ProjectCard>
      {state.kind === "ok" ? state.data.repos.map((r) => {
        const a = r.architecture;
        const note = r.error ? `구조 읽기 실패 · ${r.error}` : a ? (a.purpose ?? "목적 문구 없음") : "구조 문서 없음(docs/architecture.json)";
        const name = short(r.repo);
        return (
          <ProjectCard key={r.repo} id={r.repo} name={name} note={note} noteTone={r.error ? "danger" : "muted"} open={open.includes(r.repo)} onToggle={() => toggle(r.repo)} testId={`arch-project-${name}`}>
            {a ? <ExternalSections a={a} /> : <p className="text-[13px] text-text-muted">{r.error ? "구조 문서를 읽지 못했습니다." : "이 저장소에는 docs/architecture.json 이 없습니다."}</p>}
          </ProjectCard>
        );
      }) : (
        <p className="px-1 text-xs text-text-muted" data-testid="arch-ext-state">
          {state.kind === "loading" ? "다른 프로젝트 구조를 불러오는 중입니다." : state.kind === "unconfigured" ? "엔진 연결이 설정되지 않아 다른 프로젝트는 표시하지 않습니다." : "다른 프로젝트 구조를 불러오지 못했습니다."}
        </p>
      )}
    </div>
  );
}
