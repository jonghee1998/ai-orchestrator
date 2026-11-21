// Idea Issues ('[idea] 항목') for the dashboard. Server-only (node:crypto) — never import from a client component.
// Mirrors the engine: hash = scripts/orch/idea-review.mjs ideaHash, review marker = idea-review.mjs latestReview.
// ideas.test.ts checks the hash against the .mjs original; change them together.
import { createHash } from "node:crypto";
import type { Idea, Opinion } from "./model";

export const IDEA_PREFIX = "[idea]";
export const MAX_MINE = 4000;
const ACTIONS_BOT_ID = 41898282;
const MARK_RE = /<!-- orch-idea:v1 (\{[^<>\n]*\}) -->/;

/** Same as idea-review.mjs ideaHash: sha256(`${title}\n${body ?? ''}`) first 16 hex chars, raw title (prefix included). */
export const ideaHash = (title: string, body: string | null | undefined) =>
  createHash("sha256").update(`${title}\n${body ?? ""}`).digest("hex").slice(0, 16);

export interface IdeaIssue {
  number: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  created_at?: string;
  pull_request?: unknown;
  user?: { login?: string } | null;
}
export interface IdeaComment {
  body?: string | null;
  created_at?: string;
  user?: { id?: number; type?: string } | null;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const REC = ["now", "later", "hold"] as const;
const LEVEL = ["high", "medium", "low"] as const;

function opinion(v: unknown): Opinion | null {
  const o = obj(v);
  if (!o) return null;
  return {
    value: pick(o.value, LEVEL, "medium"),
    effort: pick(o.effort, ["S", "M", "L"] as const, "M"),
    risk: pick(o.risk, LEVEL, "medium"),
    steps: typeof o.steps === "number" && Number.isInteger(o.steps) && o.steps > 0 && o.steps < 30 ? o.steps : null,
    recommend: pick(o.recommend, REC, "later"),
    reasons: text(o.reasons, 1500),
  };
}

/** Last orch-idea marker posted by the Actions bot (a person cannot forge one). */
function latestReview(comments: IdeaComment[]): { j: Json; at: string | null } | null {
  let found: { j: Json; at: string | null } | null = null;
  for (const c of comments ?? []) {
    if (c?.user?.id !== ACTIONS_BOT_ID || c?.user?.type !== "Bot") continue;
    const m = MARK_RE.exec(c.body ?? "");
    if (!m) continue;
    try {
      const j = obj(JSON.parse(m[1]));
      if (j) found = { j, at: typeof c.created_at === "string" ? c.created_at : null };
    } catch { /* ignore broken marker */ }
  }
  return found;
}

/** Owner-authored '[idea]' Issue (not a PR). Same author rule as plans/engine. */
export function isIdeaCandidate(repo: string, issue: IdeaIssue): boolean {
  const owner = repo.split("/")[0];
  if (!issue || issue.pull_request || issue.user?.login !== owner) return false;
  return (issue.title ?? "").startsWith(IDEA_PREFIX);
}

/** An idea, or null when the Issue is not one (see isIdeaCandidate). */
export function parseIdea(repo: string, issue: IdeaIssue, comments: IdeaComment[]): Idea | null {
  if (!isIdeaCandidate(repo, issue)) return null;
  const rawTitle = issue.title ?? "";
  const hash = ideaHash(rawTitle, issue.body);
  const r = latestReview(comments);
  const status: Idea["status"] = !r ? "collecting" : r.j.hash !== hash ? "stale" : r.j.codexPending === true ? "codex_pending" : "done";
  return {
    repo,
    number: issue.number,
    url: issue.html_url ?? `https://github.com/${repo}/issues/${issue.number}`,
    title: rawTitle.slice(IDEA_PREFIX.length).trim(),
    mine: (issue.body ?? "").slice(0, MAX_MINE),
    createdAt: typeof issue.created_at === "string" ? issue.created_at : null,
    closed: issue.state === "closed",
    status,
    review: r ? {
      recommend: pick(r.j.recommend, REC, "later"),
      summary: text(r.j.summary, 2000),
      agree: text(r.j.agree, 500),
      disagree: text(r.j.disagree, 500),
      at: r.at,
      claude: opinion(r.j.claude),
      codex: opinion(r.j.codex),
    } : null,
  };
}
