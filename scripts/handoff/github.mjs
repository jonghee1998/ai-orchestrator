// Issue #73 — minimal GitHub REST client for the coordinator. No dependencies.
// Bounded retry: idempotent requests (GET/PATCH) retry up to 3 attempts on network errors, 429 and 5xx.
// POST (create) is never retried in-process — an ambiguous failure is resolved by the claim marker on rerun.
const API = "https://api.github.com";

export function createClient({ token, repo, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxAttempts = 3 }) {
  if (!token) throw new Error("GITHUB_TOKEN missing");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error("invalid repo");

  async function req(method, path, body) {
    const retryable = method === "GET" || method === "PATCH";
    for (let attempt = 1; ; attempt++) {
      let res, err;
      try {
        res = await fetchImpl(`${API}/repos/${repo}${path}`, {
          method, redirect: "error", signal: AbortSignal.timeout(15000),
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "handoff-coordinator", ...(body ? { "content-type": "application/json" } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) { err = e; }
      const transient = err || res.status === 429 || res.status >= 500;
      if (!transient) {
        if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}`);
        return res.status === 204 ? null : res.json();
      }
      if (!retryable || attempt >= maxAttempts) throw new Error(`GitHub ${method} ${path} failed after ${attempt} attempt(s): ${err ? err.message : res.status}`);
      await sleep(1000 * 2 ** (attempt - 1));
    }
  }

  // Bounded pagination. `stop(item)` ends the scan early on a match. Exhausting the bound with a full
  // last page throws: a truncated scan could miss a claim/issue/marker and cause a duplicate write.
  async function paged(path, maxPages, stop) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const items = await req("GET", `${path}${sep}per_page=100&page=${page}`);
      if (!Array.isArray(items)) throw new Error(`unexpected non-array page for ${path}`);
      if (stop) { const hit = items.find(stop); if (hit) return { items: out.concat(items), hit }; }
      out.push(...items);
      if (items.length < 100) return { items: out, hit: null };
    }
    throw new Error(`pagination bound exceeded for ${path}`); // fail closed
  }
  const isoSince = (since) => {
    const t = Date.parse(since ?? "");
    if (!Number.isFinite(t)) throw new Error("since timestamp required"); // never fall back to an unbounded scan
    return encodeURIComponent(new Date(t).toISOString());
  };

  return {
    getPull: (n) => req("GET", `/pulls/${n}`),
    getIssue: (n) => req("GET", `/issues/${n}`),
    // Read-only evidence for the lifecycle dry-run (Issue #138). GET only.
    getCommit: (sha) => req("GET", `/commits/${sha}`),
    getBranch: (name) => req("GET", `/branches/${encodeURIComponent(name)}`),
    compare: (base, head) => req("GET", `/compare/${base}...${head}?per_page=1`),
    // Issue #182: full compare (commits list, bounded). Used ONLY for the correction boundary; any gap throws => fail closed.
    compareCommits: async (base, head) => {
      const first = await req("GET", `/compare/${base}...${head}?per_page=100&page=1`);
      const commits = Array.isArray(first?.commits) ? [...first.commits] : null;
      if (!commits) throw new Error("compare returned no commits array");
      for (let page = 2; commits.length < (first.total_commits ?? 0) && page <= 3; page++) {
        const next = await req("GET", `/compare/${base}...${head}?per_page=100&page=${page}`);
        if (!Array.isArray(next?.commits) || next.commits.length === 0) break;
        commits.push(...next.commits);
      }
      return { status: first.status, ahead_by: first.ahead_by, behind_by: first.behind_by, merge_base_sha: first.merge_base_commit?.sha, total_commits: first.total_commits, commits };
    },
    listCheckRuns: (sha) => req("GET", `/commits/${sha}/check-runs?per_page=100`),
    // Vercel reports a COMMIT STATUS on this repo (not a GitHub deployment environment) — Issue #141 F5.
    getCombinedStatus: (sha) => req("GET", `/commits/${sha}/status?per_page=100`),
    // Issue #172: root-wide enumeration (GET only, bounded; exhausting the bound throws => fail closed, never a partial view).
    listIssues: async () => (await paged(`/issues?state=all&sort=created&direction=asc`, 10)).items,
    listPulls: async () => (await paged(`/pulls?state=all&sort=created&direction=asc`, 10)).items,
    listIssueComments: async (n) => (await paged(`/issues/${n}/comments`, 10)).items,
    // Issue #174: quality-gate CLI. Commits of a PR (bounded) and a commit status (the ONLY write: context-scoped, from trusted base code).
    listPullCommits: async (n) => (await paged(`/pulls/${n}/commits`, 3)).items,
    createCommitStatus: (sha, { state, context, description }) => req("POST", `/statuses/${sha}`, { state, context, description: String(description ?? "").slice(0, 140) }),
    createIssueComment: (n, body) => req("POST", `/issues/${n}/comments`, { body }),
    updateIssueComment: (id, body) => req("PATCH", `/issues/comments/${id}`, { body }),
    createIssue: ({ title, body, labels }) => req("POST", `/issues`, { title, body, labels }),
    /**
     * Recovery lookup for a pending claim. The revision issue is always created after its claim comment,
     * so `since` (the claim's created_at) bounds the scan; it is paginated and fails closed at the bound.
     */
    async findIssueByMarker(marker, writerLogin, since) {
      const { hit } = await paged(`/issues?state=all&sort=created&direction=desc&since=${isoSince(since)}`, 10,
        (i) => !i.pull_request && i.user?.login === writerLogin && (i.body ?? "").includes(marker));
      return hit;
    },
    /**
     * Issue-side PM evidence created/updated since `since` (the PR's created_at — a `pr<N>` marker cannot
     * predate PR N): all repository issue comments plus issue bodies (separate revision issues).
     * Items are tagged with `kind`; authorship is checked by the caller. Bounded, fails closed.
     */
    async listIssueSideEvidence(since) {
      const s = isoSince(since);
      const comments = (await paged(`/issues/comments?sort=created&direction=asc&since=${s}`, 20)).items;
      const issues = (await paged(`/issues?state=all&sort=created&direction=asc&since=${s}`, 10)).items;
      return [
        ...comments.map((c) => ({ kind: "comment", id: c.id, user: c.user, body: c.body, url: c.html_url })),
        ...issues.filter((i) => !i.pull_request).map((i) => ({ kind: "issue", id: i.number, user: i.user, body: i.body, url: i.html_url })),
      ];
    },
  };
}
