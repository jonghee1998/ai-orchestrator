// Issue #31 — honest GitHub integration status: configured / live / unknown. Read-only (GET only), never returns values.
export type IntegrationState = "unconfigured" | "configured_unverified" | "live" | "error";
export interface GitHubIntegration {
  state: IntegrationState;
  repo: string | null;
  /** "dedicated" = GITHUB_READ_TOKEN; "shared" = falling back to GITHUB_TOKEN (write-capable, least privilege not met). */
  tokenSource: "dedicated" | "shared" | "none";
  /** Whether the token is provably read-only. A GET cannot prove absence of write scope => "unknown" unless verifiably not. */
  readOnly: "unknown" | "no_write_scope_header";
  openIssues: number | null;
  error?: string;
}
type Env = Readonly<Record<string, string | undefined>>;
const REPO = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export function githubReadConfig(env: Env) {
  const dedicated = env.GITHUB_READ_TOKEN?.trim();
  const shared = env.GITHUB_TOKEN?.trim();
  const token = dedicated || shared;
  const m = REPO.exec(env.GITHUB_REPO?.trim() ?? "");
  return { token, repo: m ? `${m[1]}/${m[2]}` : null, tokenSource: (dedicated ? "dedicated" : shared ? "shared" : "none") as GitHubIntegration["tokenSource"] };
}

export async function probeGitHub(env: Env, request: typeof fetch = fetch): Promise<GitHubIntegration> {
  const c = githubReadConfig(env);
  const base = { repo: c.repo, tokenSource: c.tokenSource, readOnly: "unknown" as const, openIssues: null };
  if (!c.token || !c.repo) return { ...base, state: "unconfigured" };
  try {
    const res = await request(`https://api.github.com/repos/${c.repo}`, {
      method: "GET", cache: "no-store", signal: AbortSignal.timeout(8000),
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${c.token}`, "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (!res.ok) return { ...base, state: "error", error: `http ${res.status}` };
    const scopes = res.headers.get("x-oauth-scopes"); // classic PATs only; fine-grained tokens expose none
    const j = (await res.json().catch(() => ({}))) as { open_issues_count?: unknown };
    return {
      ...base, state: "live",
      readOnly: scopes !== null && !/\b(repo|public_repo)\b/.test(scopes) ? "no_write_scope_header" : "unknown",
      openIssues: typeof j.open_issues_count === "number" ? j.open_issues_count : null,
    };
  } catch {
    return { ...base, state: "error", error: "network or timeout" };
  }
}
