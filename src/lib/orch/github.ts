// GitHub REST I/O for the orchestrator dashboard. Server-only.
//   reads : run Issues (labels orch:run open, orch:done recent), repository variables (ORCH_*)
//   writes: one repository variable per switch change, then wakes the engine (orchestrator.yml dispatch)
// Token: ORCH_GITHUB_TOKEN (fine-grained: Issues read, Variables read/write, Actions read/write).
// Reads fall back to GITHUB_READ_TOKEN / GITHUB_TOKEN; writes never do.
import { parseRun, sortRuns, switchesFromVars, type OrchRun, type RepoView } from "./model";

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
    call(f, token, "GET", `/repos/${repo}/issues?labels=orch:done&state=closed&per_page=5&sort=updated`),
  ]);
  const issues = [...(open as never[]), ...(done as never[])].filter((i: { pull_request?: unknown }) => !i.pull_request);
  return sortRuns(issues.map((i) => parseRun(repo, i)).filter((r): r is OrchRun => r !== null));
}

async function readVars(f: Fetch, token: string, repo: string) {
  const j = (await call(f, token, "GET", `/repos/${repo}/actions/variables?per_page=30`)) as { variables?: { name: string; value: string }[] };
  return switchesFromVars(j.variables ?? []);
}

export async function readRepo(repo: string, env: Env, f: Fetch = fetch): Promise<RepoView> {
  const token = readToken(env);
  const [runs, sw] = await Promise.allSettled([readRuns(f, token, repo), readVars(f, token, repo)]);
  return {
    repo,
    runs: runs.status === "fulfilled" ? runs.value : [],
    runsError: runs.status === "rejected" ? describe(runs.reason) : null,
    switches: sw.status === "fulfilled" ? sw.value : null,
    switchesError: sw.status === "rejected" ? describe(sw.reason) : null,
  };
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
