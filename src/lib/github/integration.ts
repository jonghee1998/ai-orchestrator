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
  /** #34: Issues read access proven by a real GET /repos/{repo}/issues (repo GET alone does not prove it). */
  issues: "readable" | "disabled" | "denied" | "unknown";
  /** #67: the extra reads /api/evidence requires (readGitHubEvidence rejects the whole report if any fails).
   *  Probed only once the queue read is live; they never change `state` (queue liveness). "no_sample" = the repo
   *  has no PRs, so the reader issues no per-PR review/commit reads either. */
  evidenceReads: EvidenceReads;
  error?: string;
}
export type ReadProof = "readable" | "denied" | "error" | "no_sample" | "not_probed";
export interface EvidenceReads { pulls: ReadProof; comments: ReadProof; reviews: ReadProof; commits: ReadProof }
const NOT_PROBED: EvidenceReads = { pulls: "not_probed", comments: "not_probed", reviews: "not_probed", commits: "not_probed" };
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
  const base = { repo: c.repo, tokenSource: c.tokenSource, readOnly: "unknown" as const, openIssues: null, issues: "unknown" as GitHubIntegration["issues"], evidenceReads: NOT_PROBED };
  if (!c.token || !c.repo) return { ...base, state: "unconfigured" };
  const get = (path: string) => request(`https://api.github.com/repos/${c.repo}${path}`, {
    method: "GET", cache: "no-store", signal: AbortSignal.timeout(8000),
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${c.token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  try {
    const res = await get("");
    if (!res.ok) return { ...base, state: "error", error: `http ${res.status}` };
    const scopes = res.headers.get("x-oauth-scopes"); // classic PATs only; fine-grained tokens expose none
    const j = (await res.json().catch(() => ({}))) as { open_issues_count?: unknown; has_issues?: unknown };
    const readOnly = scopes !== null && !/\b(repo|public_repo)\b/.test(scopes) ? "no_write_scope_header" as const : "unknown" as const;
    const openIssues = typeof j.open_issues_count === "number" ? j.open_issues_count : null;
    if (j.has_issues === false) return { ...base, readOnly, openIssues, state: "error", issues: "disabled", error: "issues disabled on repo" };
    // The work queue reads /issues; prove THAT endpoint works with this token (fine-grained tokens need Issues:read).
    const ir = await get("/issues?state=open&per_page=1");
    if (!ir.ok) {
      const issues = ir.status === 410 ? "disabled" as const : ir.status === 401 || ir.status === 403 || ir.status === 404 ? "denied" as const : "unknown" as const;
      return { ...base, readOnly, openIssues, state: "error", issues, error: `issues http ${ir.status}` };
    }
    const list = await ir.json().catch(() => null);
    if (!Array.isArray(list)) return { ...base, readOnly, openIssues, state: "error", issues: "unknown", error: "issues response not a list" };
    return { ...base, readOnly, openIssues, state: "live", issues: "readable", evidenceReads: await probeEvidenceReads(get) };
  } catch {
    return { ...base, state: "error", error: "network or timeout" };
  }
}

/** #67: one GET per endpoint the evidence reader uses (per_page=1). Read-only; a failure is reported per endpoint. */
async function probeEvidenceReads(get: (path: string) => Promise<Response>): Promise<EvidenceReads> {
  const list = async (path: string): Promise<{ proof: ReadProof; items: unknown[] }> => {
    try {
      const r = await get(path);
      if (!r.ok) return { proof: r.status === 401 || r.status === 403 || r.status === 404 ? "denied" : "error", items: [] };
      const j = await r.json().catch(() => null);
      return Array.isArray(j) ? { proof: "readable", items: j } : { proof: "error", items: [] };
    } catch { return { proof: "error", items: [] }; }
  };
  const [pulls, comments] = await Promise.all([list("/pulls?state=all&per_page=1"), list("/issues/comments?per_page=1")]);
  if (pulls.proof !== "readable") return { pulls: pulls.proof, comments: comments.proof, reviews: "not_probed", commits: "not_probed" };
  const n = (pulls.items[0] as { number?: unknown } | undefined)?.number;
  if (typeof n !== "number" || !Number.isInteger(n)) return { pulls: "readable", comments: comments.proof, reviews: "no_sample", commits: "no_sample" };
  const [reviews, commits] = await Promise.all([list(`/pulls/${n}/reviews?per_page=1`), list(`/pulls/${n}/commits?per_page=1`)]);
  return { pulls: "readable", comments: comments.proof, reviews: reviews.proof, commits: commits.proof };
}
