// Issue #60 — bounded, read-only GitHub REST reader for collaboration evidence. GET only; no writes.
import { buildEvidence, linkPulls, type EvidenceReport, type RawComment, type RawCommit, type RawIssue, type RawPull, type RawReview } from "./evidence";

export class EvidenceConfigurationError extends Error {}
export class EvidenceReadError extends Error {}

export const EVIDENCE_LIMITS = { issuePages: 3, pullPages: 1, commentPages: 5, detailPulls: 30, concurrency: 5 } as const;

function repository(value: string): string | undefined {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) ? value : undefined;
}

export async function readGitHubEvidence(
  env: Readonly<Record<string, string | undefined>> = process.env,
  request: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<EvidenceReport> {
  const token = env.GITHUB_READ_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  const repo = repository(env.GITHUB_REPO?.trim() ?? "");
  if (!token || !repo) throw new EvidenceConfigurationError("github_unconfigured");

  async function get<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const url = new URL(`https://api.github.com/repos/${repo}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    let r: Response;
    try {
      r = await request(url, {
        method: "GET", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      });
    } catch { throw new EvidenceReadError("github_request_failed"); }
    if (!r.ok) throw new EvidenceReadError(`github_http_${r.status}`);
    let j: unknown;
    try { j = await r.json(); } catch { throw new EvidenceReadError("github_invalid_json"); }
    if (!Array.isArray(j)) throw new EvidenceReadError("github_invalid_payload");
    return j as T[];
  }
  async function pages<T>(path: string, params: Record<string, string>, max: number): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    for (let page = 1; page <= max; page += 1) {
      const got = await get<T>(path, { ...params, per_page: "100", page: String(page) });
      items.push(...got);
      if (got.length < 100) return { items, truncated: false };
    }
    return { items, truncated: true };
  }

  const [issues, pulls, comments] = await Promise.all([
    pages<RawIssue>("/issues", { state: "all", sort: "updated", direction: "desc" }, EVIDENCE_LIMITS.issuePages),
    pages<RawPull>("/pulls", { state: "all", sort: "updated", direction: "desc" }, EVIDENCE_LIMITS.pullPages),
    pages<RawComment>("/issues/comments", { sort: "created", direction: "desc" }, EVIDENCE_LIMITS.commentPages),
  ]);

  // Detail (reviews + commits) only for PRs that are linked to an issue, most recently updated first.
  const linked = new Set<number>();
  for (const m of linkPulls(issues.items, pulls.items, comments.items).values()) for (const n of m.keys()) linked.add(n);
  const targets = pulls.items
    .filter((p) => linked.has(p.number))
    .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))
    .slice(0, EVIDENCE_LIMITS.detailPulls)
    .map((p) => p.number);
  const pullDetail = new Map<number, { reviews: RawReview[]; commits: RawCommit[]; commitsTruncated: boolean }>();
  for (let i = 0; i < targets.length; i += EVIDENCE_LIMITS.concurrency) {
    await Promise.all(targets.slice(i, i + EVIDENCE_LIMITS.concurrency).map(async (n) => {
      const [reviews, commits] = await Promise.all([
        pages<RawReview>(`/pulls/${n}/reviews`, {}, 1),
        pages<RawCommit>(`/pulls/${n}/commits`, {}, 1),
      ]);
      pullDetail.set(n, { reviews: reviews.items, commits: commits.items, commitsTruncated: commits.truncated });
    }));
  }

  return buildEvidence({
    repo, generatedAt: now().toISOString(), issues: issues.items, pulls: pulls.items, comments: comments.items,
    pullDetail, commentsTruncated: comments.truncated, pullsTruncated: pulls.truncated, issuesTruncated: issues.truncated,
  });
}
