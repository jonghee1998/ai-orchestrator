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

  async function paged(path, maxPages) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const items = await req("GET", `${path}${sep}per_page=100&page=${page}`);
      out.push(...items);
      if (items.length < 100) return out;
    }
    throw new Error(`pagination bound exceeded for ${path}`); // fail closed: a missed claim could duplicate
  }

  return {
    getPull: (n) => req("GET", `/pulls/${n}`),
    getIssue: (n) => req("GET", `/issues/${n}`),
    listIssueComments: (n) => paged(`/issues/${n}/comments`, 10),
    createIssueComment: (n, body) => req("POST", `/issues/${n}/comments`, { body }),
    updateIssueComment: (id, body) => req("PATCH", `/issues/comments/${id}`, { body }),
    createIssue: ({ title, body, labels }) => req("POST", `/issues`, { title, body, labels }),
    async findIssueByMarker(marker, writerLogin) {
      const items = await req("GET", `/issues?state=all&sort=created&direction=desc&per_page=100`);
      return items.find((i) => !i.pull_request && i.user?.login === writerLogin && (i.body ?? "").includes(marker)) ?? null;
    },
  };
}
