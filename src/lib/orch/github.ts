// GitHub REST I/O for the orchestrator dashboard. Server-only.
//   reads : run Issues (labels orch:run open, orch:done recent), repository variables (ORCH_*),
//           pending '[plan]' Issues + their plan-review comments, recent '[idea]' Issues + their idea-review comments,
//           docs/roadmap.json · docs/patchnotes.json (contents API) and merge commits since tag prod-deployed (compare API; Contents: Read)
//   writes: one repository variable per switch change, then wakes the engine (orchestrator.yml dispatch);
//           'orch:go' label on plan approval; one '[idea]' Issue per idea
// Token: ORCH_GITHUB_TOKEN (fine-grained: Issues read and write, Variables read/write, Actions read/write).
//   Issues: Read and write 필요(계획 승인·아이디어 등록), 토큰 주인이 저장소 소유자여야 등록한 아이디어가 화면에 보임
//   (화면은 저장소 소유자가 쓴 '[idea]' Issue만 보여 준다).
// Reads fall back to GITHUB_READ_TOKEN / GITHUB_TOKEN; writes never do.
import type { PatchNote } from "@/lib/patchnotes";
import { USAGE_RETRY_MS, deployEveryFromVars, isSelfRepo, parseRoadmap, parseRun, parseUsage, sortRuns, switchesFromVars, usageStale, type Idea, type OrchRun, type PendingPlan, type RepoView, type Roadmap, type UsageRefresh, type UsageView, parsePatchNotes } from "./model";
import { isPlanCandidate, parsePendingPlan, type PlanComment, type PlanIssue } from "./plans";
import { IDEA_PREFIX, MAX_MINE, isIdeaCandidate, parseIdea, type IdeaComment, type IdeaIssue } from "./ideas";

type Env = Readonly<Record<string, string | undefined>>;
type Fetch = typeof fetch;
const apiBase = () => process.env.ORCH_GITHUB_API?.trim() || "https://api.github.com"; // override for tests / GHES

export const readToken = (env: Env) => env.ORCH_GITHUB_TOKEN?.trim() || env.GITHUB_READ_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || "";
export const writeToken = (env: Env) => env.ORCH_GITHUB_TOKEN?.trim() || "";

export class GitHubError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function call(f: Fetch, token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const r = await f(`${apiBase()}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (!r.ok) throw new GitHubError(r.status, `${method} ${path.split("?")[0]} → ${r.status}`);
  return r.status === 204 ? null : r.json();
}

const describe = (e: unknown) =>
  e instanceof GitHubError
    ? e.status === 401 ? "토큰 인증 실패" : e.status === 403 || e.status === 404 ? "권한 없음 또는 저장소 없음" : `GitHub 오류 ${e.status}`
    : "네트워크 오류";

async function readRuns(f: Fetch, token: string, repo: string): Promise<OrchRun[]> {
  const [open, done] = await Promise.all([
    call(f, token, "GET", `/repos/${repo}/issues?labels=orch:run&state=open&per_page=30`),
    call(f, token, "GET", `/repos/${repo}/issues?labels=orch:done&state=closed&per_page=20&sort=updated`),
  ]);
  const issues = [...(open as never[]), ...(done as never[])].filter((i: { pull_request?: unknown }) => !i.pull_request);
  return sortRuns(issues.map((i) => parseRun(repo, i)).filter((r): r is OrchRun => r !== null));
}

const VARS_PER_PAGE = 100;
/** GitHub allows 500 repository variables, so 5 pages; more than this means the listing never ended. */
const VARS_MAX_PAGES = 10;

/**
 * Every repository variable, page by page (stops at total_count or a short page). Any failing page throws,
 * so the caller shows switches as unreadable (null) instead of guessing defaults from a partial list.
 */
async function readVars(f: Fetch, token: string, repo: string) {
  const vars: { name: string; value: string }[] = [];
  for (let page = 1; ; page++) {
    if (page > VARS_MAX_PAGES) throw new GitHubError(500, "variables: too many pages");
    const j = (await call(f, token, "GET", `/repos/${repo}/actions/variables?per_page=${VARS_PER_PAGE}&page=${page}`)) as { total_count?: unknown; variables?: { name: string; value: string }[] } | null;
    const list = Array.isArray(j?.variables) ? j.variables : [];
    vars.push(...list);
    const total = typeof j?.total_count === "number" && Number.isFinite(j.total_count) ? j.total_count : null;
    if (total !== null && vars.length >= total) break;
    if (list.length === 0) {
      if (total !== null && page > 1) throw new GitHubError(500, "variables: listing ended before total_count");
      break;
    }
    if (total === null && list.length < VARS_PER_PAGE) break;
  }
  return { switches: switchesFromVars(vars), deployEvery: deployEveryFromVars(vars) };
}

export class RoadmapFormatError extends Error {}
export class PatchNotesFormatError extends Error {}

/** docs/patchnotes.json on the default branch (other projects). Throws GitHubError (404 = no file) or PatchNotesFormatError. */
async function readPatchNotes(f: Fetch, token: string, repo: string): Promise<PatchNote[]> {
  const j = (await call(f, token, "GET", `/repos/${repo}/contents/docs/patchnotes.json`)) as { content?: string; encoding?: string } | null;
  if (typeof j?.content !== "string" || (j.encoding && j.encoding !== "base64")) throw new PatchNotesFormatError("patchnotes.json 내용 없음");
  const notes = parsePatchNotes(Buffer.from(j.content, "base64").toString("utf8"));
  if (!notes) throw new PatchNotesFormatError("patchnotes.json 형식 오류");
  return notes;
}

/** docs/roadmap.json on the default branch. Throws GitHubError (404 = no file) or RoadmapFormatError. */
async function readRoadmap(f: Fetch, token: string, repo: string): Promise<Roadmap> {
  const j = (await call(f, token, "GET", `/repos/${repo}/contents/docs/roadmap.json`)) as { content?: string; encoding?: string } | null;
  if (typeof j?.content !== "string" || (j.encoding && j.encoding !== "base64")) throw new RoadmapFormatError("roadmap.json 내용 없음");
  const roadmap = parseRoadmap(Buffer.from(j.content, "base64").toString("utf8"));
  if (!roadmap) throw new RoadmapFormatError("roadmap.json 형식 오류");
  return roadmap;
}

type CompareCommit = { parents?: unknown[] } | null | undefined;

/**
 * Merge commits (parents > 1) between tag prod-deployed and main. null when the tag is missing or the read fails.
 * Approximation: deploy.yml counts `git rev-list --count --first-parent prod-deployed..HEAD`, which also counts
 * direct (non-merge) commits on main and ignores merges inside merged branches; compare also caps at 250 commits.
 */
async function readDeployPending(f: Fetch, token: string, repo: string): Promise<{ count: number } | null> {
  try {
    const j = (await call(f, token, "GET", `/repos/${repo}/compare/prod-deployed...main`)) as { commits?: CompareCommit[] } | null;
    if (!Array.isArray(j?.commits)) return null;
    const isMerge = (c: CompareCommit) => Array.isArray(c?.parents) && c.parents.length > 1;
    return { count: j.commits.filter(isMerge).length };
  } catch {
    return null;
  }
}

async function readUsageIssue(f: Fetch, token: string, repo: string): Promise<UsageView | null> {
  const list = (await call(f, token, "GET", `/repos/${repo}/issues?labels=orch:usage&state=open&per_page=1`)) as { body?: string }[];
  return parseUsage(list?.[0]?.body);
}

/** Plans read per repo; each costs one comments request. */
export const MAX_PENDING_PLANS = 5;

export async function readPendingPlans(f: Fetch, token: string, repo: string): Promise<PendingPlan[]> {
  const issues = (await call(f, token, "GET", `/repos/${repo}/issues?state=open&per_page=30`)) as PlanIssue[];
  const candidates = (Array.isArray(issues) ? issues : [])
    .filter((i) => isPlanCandidate(repo, i) && parsePendingPlan(repo, i, []) !== null)
    .slice(0, MAX_PENDING_PLANS);
  const list = await Promise.all(candidates.map(async (i) => {
    // Limit: only the first page (100 comments) is read; a plan Issue with more comments may show an older review round.
    const comments = (await call(f, token, "GET", `/repos/${repo}/issues/${i.number}/comments?per_page=100`)) as PlanComment[];
    return parsePendingPlan(repo, i, Array.isArray(comments) ? comments : []);
  }));
  return list.filter((p): p is PendingPlan => p !== null);
}

/** Ideas read per repo (newest first); each costs one comments request. */
export const MAX_IDEAS = 15;

export async function readIdeas(f: Fetch, token: string, repo: string): Promise<Idea[]> {
  const issues = (await call(f, token, "GET", `/repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=50`)) as IdeaIssue[];
  const candidates = (Array.isArray(issues) ? issues : []).filter((i) => isIdeaCandidate(repo, i)).slice(0, MAX_IDEAS);
  const list = await Promise.all(candidates.map(async (i) => {
    const comments = (await call(f, token, "GET", `/repos/${repo}/issues/${i.number}/comments?per_page=100`)) as IdeaComment[];
    return parseIdea(repo, i, Array.isArray(comments) ? comments : []);
  }));
  return list.filter((x): x is Idea => x !== null);
}

export async function readRepo(repo: string, env: Env, f: Fetch = fetch): Promise<RepoView> {
  const token = readToken(env);
  const [runs, sw, usage, plans, ideas, roadmap, pending, notes] = await Promise.allSettled([
    readRuns(f, token, repo), readVars(f, token, repo), readUsageIssue(f, token, repo), readPendingPlans(f, token, repo), readIdeas(f, token, repo),
    readRoadmap(f, token, repo), readDeployPending(f, token, repo), readPatchNotes(f, token, repo),
  ]);
  const notesMissing = notes.status === "rejected" && notes.reason instanceof GitHubError && notes.reason.status === 404;
  // 404 = this project has no roadmap file (not an error). describe() lumps 403 and 404 together, so compare directly.
  const roadmapMissing = roadmap.status === "rejected" && roadmap.reason instanceof GitHubError && roadmap.reason.status === 404;
  return {
    repo,
    usage: usage.status === "fulfilled" ? usage.value : null,
    runs: runs.status === "fulfilled" ? runs.value : [],
    runsError: runs.status === "rejected" ? describe(runs.reason) : null,
    switches: sw.status === "fulfilled" ? sw.value.switches : null,
    switchesError: sw.status === "rejected" ? describe(sw.reason) : null,
    plans: plans.status === "fulfilled" ? plans.value : [],
    plansError: plans.status === "rejected" ? describe(plans.reason) : null,
    ideas: ideas.status === "fulfilled" ? ideas.value : [],
    ideasError: ideas.status === "rejected" ? describe(ideas.reason) : null,
    roadmap: roadmap.status === "fulfilled" ? roadmap.value : null,
    roadmapError: roadmap.status === "fulfilled" || roadmapMissing ? null
      : roadmap.reason instanceof RoadmapFormatError ? roadmap.reason.message : describe(roadmap.reason),
    deployPending: pending.status === "fulfilled" ? pending.value?.count ?? null : null,
    deployEvery: sw.status === "fulfilled" ? sw.value.deployEvery : 10,
    patchNotes: notes.status === "fulfilled" ? notes.value : null,
    patchNotesError: notes.status === "fulfilled" || notesMissing ? null
      : notes.reason instanceof PatchNotesFormatError ? notes.reason.message : describe(notes.reason),
    isSelf: isSelfRepo(repo, env),
  };
}

/**
 * If the usage snapshot is stale, ask GitHub to run usage.yml now (best effort, throttled by the last run's start time).
 * GitHub often skips scheduled runs, so opening the dashboard is what keeps usage current.
 */
export async function refreshUsageIfStale(repo: string, usage: UsageView | null | undefined, env: Env, nowMs = Date.now(), f: Fetch = fetch): Promise<UsageRefresh> {
  if (!usageStale(usage, nowMs)) return "fresh";
  return requestUsageRun(repo, env, nowMs, USAGE_RETRY_MS, f);
}

/** Manual refresh button: run usage.yml now unless one started in the last 2 minutes. */
export const USAGE_MANUAL_GAP_MS = 2 * 60_000;

export async function requestUsageRun(repo: string, env: Env, nowMs = Date.now(), minGapMs = USAGE_MANUAL_GAP_MS, f: Fetch = fetch): Promise<UsageRefresh> {
  const token = writeToken(env);
  if (!token) return "unavailable";
  try {
    const j = (await call(f, token, "GET", `/repos/${repo}/actions/workflows/usage.yml/runs?per_page=1`)) as { workflow_runs?: { created_at?: string }[] };
    const last = Date.parse(j.workflow_runs?.[0]?.created_at ?? "");
    if (Number.isFinite(last) && nowMs - last < minGapMs) return "running";
    await call(f, token, "POST", `/repos/${repo}/actions/workflows/usage.yml/dispatches`, { ref: "main" });
    return "requested";
  } catch {
    return "unavailable";
  }
}

/**
 * Write one switch variable, then wake the engine so held work resumes now (best effort).
 * Save failure throws (GitHubError; 503 = no write token); saved but wake failed → { woke: false }.
 */
export async function writeSwitch(repo: string, name: string, value: string, env: Env, f: Fetch = fetch): Promise<{ woke: boolean }> {
  const token = writeToken(env);
  if (!token) throw new GitHubError(503, "ORCH_GITHUB_TOKEN not configured");
  try {
    await call(f, token, "PATCH", `/repos/${repo}/actions/variables/${name}`, { name, value });
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 404)) throw e;
    await call(f, token, "POST", `/repos/${repo}/actions/variables`, { name, value });
  }
  try {
    await call(f, token, "POST", `/repos/${repo}/actions/workflows/orchestrator.yml/dispatches`, { ref: "main" });
    return { woke: true };
  } catch {
    return { woke: false };
  }
}

export type ApproveResult = { ok: true; issue: number } | { ok: false; error: "not_pending" | "plan_changed" };

/**
 * Approve a pending plan: re-read the Issue + comments, check it with the same rule as the dashboard
 * (parsePendingPlan: owner-authored, open, '[plan]', no orch:* label, valid plan JSON) and that its hash
 * still matches what the admin saw, then add the 'orch:go' label once. Throws GitHubError (503 = no write token).
 */
export async function approvePlan(repo: string, issue: number, hash: string, env: Env, f: Fetch = fetch): Promise<ApproveResult> {
  const token = writeToken(env);
  if (!token) throw new GitHubError(503, "ORCH_GITHUB_TOKEN not configured");
  const [i, comments] = await Promise.all([
    call(f, token, "GET", `/repos/${repo}/issues/${issue}`) as Promise<PlanIssue>,
    call(f, token, "GET", `/repos/${repo}/issues/${issue}/comments?per_page=100`) as Promise<PlanComment[]>,
  ]);
  const plan = i && i.number === issue ? parsePendingPlan(repo, i, Array.isArray(comments) ? comments : []) : null;
  if (!plan) return { ok: false, error: "not_pending" };
  if (plan.hash !== hash) return { ok: false, error: "plan_changed" };
  await call(f, token, "POST", `/repos/${repo}/issues/${issue}/labels`, { labels: ["orch:go"] });
  return { ok: true, issue };
}

export const MAX_IDEA_TITLE = 80;
export type IdeaInput = { ok: true; title: string; body: string } | { ok: false; error: "bad_title" | "bad_body" };

/** Title 1~80 chars after trim, single line; body 0~4000 chars (missing/null = empty). */
export function checkIdea(title: unknown, body: unknown): IdeaInput {
  const t = typeof title === "string" ? title.trim() : "";
  if (!t || t.length > MAX_IDEA_TITLE || /[\r\n]/.test(t)) return { ok: false, error: "bad_title" };
  const b = body === undefined || body === null ? "" : body;
  if (typeof b !== "string" || b.length > MAX_MINE) return { ok: false, error: "bad_body" };
  return { ok: true, title: t, body: b };
}

export type CreateIdeaResult = { ok: true; issue: number; url: string | null } | { ok: false; error: "bad_title" | "bad_body" };

/** Register one idea: validate, then a single POST of an '[idea] 항목' Issue. Throws GitHubError (503 = no write token). */
export async function createIdea(repo: string, title: unknown, body: unknown, env: Env, f: Fetch = fetch): Promise<CreateIdeaResult> {
  const input = checkIdea(title, body);
  if (!input.ok) return input;
  const token = writeToken(env);
  if (!token) throw new GitHubError(503, "ORCH_GITHUB_TOKEN not configured");
  const r = (await call(f, token, "POST", `/repos/${repo}/issues`, { title: `${IDEA_PREFIX} ${input.title}`, body: input.body })) as { number?: number; html_url?: string } | null;
  return { ok: true, issue: typeof r?.number === "number" ? r.number : 0, url: typeof r?.html_url === "string" ? r.html_url : null };
}

export { describe as describeGitHubError };
