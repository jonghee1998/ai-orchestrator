"use client";
// PM 브리핑 탭: 아이디어함. 일자·항목·내 의견·종합 의견(Claude+Codex)을 보여 주고, 관리자는 새 아이디어를 적을 수 있다.
// Data: GET /api/orch (repo.ideas). 등록: POST /api/orch {action:'idea'} (admin session + CSRF) → '[idea] 항목' Issue.
import { useState } from "react";
import { csrfHeaders, useSession } from "@/components/live/session";
import { formatKstShort } from "@/lib/time/kst";
import { defaultIdeaRepo, filterIdeas, ideaFilterChips, type Idea, type Opinion } from "@/lib/orch/model";
import { useOrch } from "./OrchPanels";

const short = (repo: string) => repo.split("/")[1] ?? repo;
const MAX_TITLE = 80;
const MAX_MINE = 4000;

const REC_TEXT = { now: "지금 하자", later: "나중에", hold: "보류" } as const;
const REC_TONE = { now: "bg-ok/15 text-green-200", later: "bg-warn/20 text-yellow-100", hold: "bg-current/10 text-text-muted" } as const;
const LEVEL_TEXT = { high: "높음", medium: "보통", low: "낮음" } as const;
const STATUS_NOTE: Record<Idea["status"], string | null> = {
  collecting: "의견 수집 중",
  codex_pending: "Codex 의견 대기",
  stale: "수정됨 · 의견 다시 받는 중",
  done: null,
};

const LONG_LINES = 3;
const LONG_CHARS = 120;
const isLong = (s: string) => s.split("\n").length > LONG_LINES || s.length > LONG_CHARS;

function createErrorText(status: number, body: { error?: string; detail?: string } | null): string {
  const e = body?.error;
  if (e === "bad_title") return `등록 실패 · 항목은 한 줄, 1~${MAX_TITLE}자로 적어 주세요`;
  if (e === "bad_body") return `등록 실패 · 내 의견은 ${MAX_MINE}자까지입니다`;
  if (e === "write_unconfigured") return "등록 실패 · 서버에 쓰기 토큰(ORCH_GITHUB_TOKEN)이 없습니다";
  if (e === "unknown_repo") return "등록 실패 · 알 수 없는 프로젝트입니다";
  if (status === 401 || status === 403) return "등록 실패 · 관리자 로그인이 필요합니다 (다시 로그인해 보세요)";
  return `등록 실패 · ${body?.detail ?? e ?? status}`;
}

function OpinionTable({ claude, codex }: { claude: Opinion | null; codex: Opinion | null }) {
  const rows: { name: string; o: Opinion | null }[] = [{ name: "Claude", o: claude }, { name: "Codex", o: codex }];
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-text-muted">
            <tr><th className="py-1 pr-2 font-medium">모델</th><th className="py-1 pr-2 font-medium">가치</th><th className="py-1 pr-2 font-medium">규모</th><th className="py-1 pr-2 font-medium">위험</th><th className="py-1 font-medium">추천</th></tr>
          </thead>
          <tbody>
            {rows.map(({ name, o }) => (
              <tr key={name} className="border-t border-border align-top">
                <th scope="row" className="py-1 pr-2 font-medium">{name}</th>
                {o ? <>
                  <td className="py-1 pr-2">{LEVEL_TEXT[o.value]}</td>
                  <td className="py-1 pr-2">{o.effort}{o.steps ? ` · ${o.steps}스텝` : ""}</td>
                  <td className="py-1 pr-2">{LEVEL_TEXT[o.risk]}</td>
                  <td className="py-1">{REC_TEXT[o.recommend]}</td>
                </> : <td colSpan={4} className="py-1 text-text-faint">의견 없음</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.map(({ name, o }) => o?.reasons ? <p key={name} className="break-words text-xs text-text-muted"><span className="font-medium text-text">{name}</span> · {o.reasons}</p> : null)}
    </div>
  );
}

function IdeaCard({ i }: { i: Idea }) {
  const note = STATUS_NOTE[i.status];
  const r = i.review;
  return (
    <article className={`rounded-xl border border-border p-3 ${i.closed ? "opacity-60" : ""}`} data-testid={`orch-idea-${short(i.repo)}-${i.number}`}>
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 break-words font-medium">{i.title}</p>
        {i.closed && <span className="shrink-0 rounded-full bg-current/10 px-2 py-0.5 text-xs text-text-muted">정리됨</span>}
      </div>
      <p className="mt-1 text-xs text-text-muted">{formatKstShort(i.createdAt)}{` · ${short(i.repo)}`} · #{i.number}</p>

      <div className="mt-2 text-sm">
        {!i.mine.trim() ? <p className="text-xs text-text-faint">내 의견 없음</p>
          : isLong(i.mine) ? (
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-xs text-text-muted"><span className="shrink-0">내 의견</span><span className="min-w-0 truncate">{i.mine.split("\n")[0]}</span></summary>
              <p className="whitespace-pre-wrap break-words pb-2">{i.mine}</p>
            </details>
          ) : <p className="whitespace-pre-wrap break-words"><span className="text-xs text-text-muted">내 의견 · </span>{i.mine}</p>}
      </div>

      <div className="mt-2 space-y-2 border-t border-border pt-2">
        {note && <p className="text-xs text-yellow-100">{note}</p>}
        {r && (
          <>
            <div className="flex flex-wrap items-start gap-2">
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${REC_TONE[r.recommend]}`}>{REC_TEXT[r.recommend]}</span>
              <p className="min-w-0 flex-1 break-words text-sm">{r.summary || "종합 의견 없음"}</p>
            </div>
            {r.agree && <p className="break-words text-xs"><span className="text-text-muted">같은 점 · </span>{r.agree}</p>}
            {r.disagree && <p className="break-words text-xs"><span className="text-text-muted">다른 점 · </span>{r.disagree}</p>}
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center text-xs text-text-muted">Claude·Codex 의견 표</summary>
              <OpinionTable claude={r.claude} codex={r.codex} />
            </details>
          </>
        )}
        <a href={i.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-xs underline">원문 보기</a>
      </div>
    </article>
  );
}

/** PM 브리핑 탭: 아이디어함. 프로젝트(저장소)가 2개 이상이면 필터 칩과 등록 대상 선택이 나온다. */
export function OrchIdeasPanel() {
  const { state, reload } = useOrch();
  const session = useSession();
  const [filter, setFilter] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [mine, setMine] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (state.kind !== "ok") return null; // OrchDecisionsPanel shows the loading / error note
  const repos = state.data.repos;
  const total = repos.reduce((n, v) => n + (v.ideas?.length ?? 0), 0);
  const withIdeas = repos.map((v) => ({ repo: v.repo, ideas: v.ideas ?? [] }));
  const many = repos.length > 1;
  const active = filter !== null && repos.some((v) => v.repo === filter) ? filter : null;
  const shown = filterIdeas(withIdeas, active);
  const canWrite = session.role === "admin" && state.data.canWrite;
  const target = picked !== null && repos.some((v) => v.repo === picked) ? picked : defaultIdeaRepo(repos, active);
  const errors = repos.filter((v) => v.ideasError);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !title.trim()) return;
    setBusy(true); setMsg(null);
    try {
      const r = await fetch("/api/orch", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify({ action: "idea", repo: target, title: title.trim(), body: mine }) });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; error?: string; detail?: string } | null;
      if (r.ok && j?.ok) {
        setTitle(""); setMine("");
        setMsg({ ok: true, text: "등록됨 · 1~3분 뒤 의견이 붙습니다" });
        await reload();
      } else setMsg({ ok: false, text: createErrorText(r.status, j) });
    } catch { setMsg({ ok: false, text: "등록 실패 · 네트워크 오류" }); }
    finally { setBusy(false); }
  }

  const FIELD = "w-full rounded-xl border border-border bg-bg-raised px-3 text-sm";
  return (
    <section aria-label="아이디어함" className="space-y-2" data-testid="orch-ideas">
      <h2 className="text-sm font-semibold text-text-muted">아이디어함 · {total}</h2>
      {many && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="프로젝트 필터">
          {ideaFilterChips(withIdeas).map((c) => {
            const on = c.repo === active;
            return (
              <button key={c.repo ?? "all"} type="button" aria-pressed={on} onClick={() => setFilter(c.repo)}
                className={`min-h-11 rounded-full border px-3 text-xs ${on ? "border-accent/60 bg-accent/15 font-semibold" : "border-border text-text-muted"}`}>
                {c.repo === null ? "전체" : short(c.repo)} {c.count}
              </button>
            );
          })}
        </div>
      )}
      {errors.map((v) => <p key={v.repo} className="text-xs text-red-200">{short(v.repo)} 아이디어 불러오기 실패 · {v.ideasError}</p>)}
      {canWrite && (
        <form onSubmit={submit} className="space-y-2 rounded-xl border border-border p-3" aria-label="아이디어 적기" data-testid="orch-idea-form">
          <p className="text-sm font-medium">아이디어 적기</p>
          {many && (
            <div>
              <label htmlFor="idea-repo" className="block text-xs text-text-muted">프로젝트</label>
              <select id="idea-repo" value={target} onChange={(e) => setPicked(e.target.value)} className={`${FIELD} min-h-11`}>
                {repos.map((v) => <option key={v.repo} value={v.repo}>{short(v.repo)}</option>)}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="idea-title" className="block text-xs text-text-muted">항목 (한 줄, {MAX_TITLE}자)</label>
            <input id="idea-title" value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value.replace(/[\r\n]+/g, " "))} className={`${FIELD} min-h-11`} />
          </div>
          <div>
            <label htmlFor="idea-mine" className="block text-xs text-text-muted">내 의견 ({MAX_MINE}자까지)</label>
            <textarea id="idea-mine" value={mine} maxLength={MAX_MINE} rows={4} onChange={(e) => setMine(e.target.value)} className={`${FIELD} py-2`} />
          </div>
          <button type="submit" disabled={busy || !title.trim()} className="min-h-11 rounded-lg border border-border px-4 text-sm font-semibold disabled:opacity-50">{busy ? "등록 중…" : "등록"}</button>
          {msg && <p role="status" className={`text-xs ${msg.ok ? "" : "text-red-200"}`}>{msg.text}</p>}
        </form>
      )}
      {shown.map((i) => <IdeaCard key={`${i.repo}#${i.number}`} i={i} />)}
      {!shown.length && !errors.length && <p className="text-sm text-text-faint">아이디어 없음</p>}
    </section>
  );
}
