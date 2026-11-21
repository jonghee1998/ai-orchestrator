// GitHub REST I/O for the orchestrator dashboard. Server-only.
//   reads : run Issues (labels orch:run open, orch:done recent), repository variables (ORCH_*)
//   writes: one repository variable per switch change, then wakes the engine (orchestrator.yml dispatch)
// Token: ORCH_GITHUB_TOKEN (fine-grained: Issues read, Variables read/write, Actions read/write).
// Reads fall back to GITHUB_READ_TOKEN / GITHUB_TOKEN; writes never do.
import { USAGE_RETRY_MS, parseRun, parseUsage, sortRuns, switchesFromVars, usageStale, type OrchRun, type RepoView, type UsageRefresh, type UsageView } from "./model";

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

async function readVars(f: Fetch, token: string, repo: string) {
  const j = (await call(f, token, "GET", `/repos/${repo}/actions/variables?per_page=30`)) as { variables?: { name: string; value: string }[] };
  return switchesFromVars(j.variables ?? []);
}

async function readUsageIssue(f: Fetch, token: string, repo: string): Promise<UsageView | null> {
  const list = (await call(f, token, "GET", `/repos/${repo}/issues?labels=orch:usage&state=open&per_page=1`)) as { body?: string }[];
  return parseUsage(list?.[0]?.body);
}

export async function readRepo(repo: string, env: Env, f: Fetch = fetch): Promise<RepoView> {
  const token = readToken(env);
  const [runs, sw, usage] = await Promise.allSettled([readRuns(f, token, repo), readVars(f, token, repo), readUsageIssue(f, token, repo)]);
  return {
    repo,
    usage: usage.status === "fulfilled" ? usage.value : null,
    runs: runs.status === "fulfilled" ? runs.value : [],
    runsError: runs.status === "rejected" ? describe(runs.reason) : null,
    switches: sw.status === "fulfilled" ? sw.value : null,
    switchesError: sw.status === "rejected" ? describe(sw.reason) : null,
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

/** Write one switch variable, then wake the engine so held work resumes now (best effort). */
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

export { describe as describeGitHubError };
