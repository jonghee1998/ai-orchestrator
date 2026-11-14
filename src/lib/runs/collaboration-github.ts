/** GitHub evidence is read from the configured repository, never from a worker-supplied URL. */
export interface PullSnapshot {
  number: number; repo: string; headBranch: string; headSha: string; baseBranch: string; url: string; open: boolean;
}
export interface CollaborationGitHub {
  branch(repo: string, branch: string): Promise<string>;
  pull(repo: string, number: number): Promise<PullSnapshot>;
  descendsFrom(repo: string, baseSha: string, headSha: string): Promise<boolean>;
}
export const validRepo = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s);
export const validSha = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{40}$/.test(s);
export const validBranch = (s: unknown): s is string => typeof s === "string" && s.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(s) && !s.includes("..") && !s.includes("//") && !s.endsWith("/") && !s.endsWith(".lock");

export class CollaborationGitHubError extends Error {}
export class GitHubEvidenceReader implements CollaborationGitHub {
  constructor(private repo: string, private token: string, private request: typeof fetch = fetch) {}
  private async get(repo: string, path: string): Promise<Record<string, any>> { // external payload validated below
    if (!validRepo(repo) || repo !== this.repo || !this.token) throw new CollaborationGitHubError("github_unconfigured");
    try {
      const r = await this.request(`https://api.github.com/repos/${repo}${path}`, {
        method: "GET", cache: "no-store", signal: AbortSignal.timeout(10_000), redirect: "error",
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!r.ok) throw new Error();
      return await r.json();
    } catch { throw new CollaborationGitHubError("github_evidence_unavailable"); }
  }
  async branch(repo: string, branch: string) {
    if (!validBranch(branch)) throw new CollaborationGitHubError("invalid_branch");
    const j = await this.get(repo, `/branches/${encodeURIComponent(branch)}`);
    if (!validSha(j.commit?.sha)) throw new CollaborationGitHubError("invalid_branch_evidence");
    return j.commit.sha as string;
  }
  async descendsFrom(repo: string, baseSha: string, headSha: string) {
    if (!validSha(baseSha) || !validSha(headSha)) throw new CollaborationGitHubError("invalid_commit_evidence");
    if (baseSha === headSha) return true;
    const j = await this.get(repo, `/compare/${baseSha}...${headSha}`);
    return ["ahead", "identical"].includes(j.status) && j.merge_base_commit?.sha === baseSha;
  }
  async pull(repo: string, number: number): Promise<PullSnapshot> {
    if (!Number.isSafeInteger(number) || number <= 0) throw new CollaborationGitHubError("invalid_pr");
    const j = await this.get(repo, `/pulls/${number}`);
    // Fork PRs are deliberately unsupported: an untrusted fork must not become a subscription execution target.
    if (j.number !== number || j.head?.repo?.full_name !== repo || j.base?.repo?.full_name !== repo ||
        !validSha(j.head?.sha) || !validBranch(j.head?.ref) || !validBranch(j.base?.ref) || !["open", "closed"].includes(j.state))
      throw new CollaborationGitHubError("invalid_pr_evidence");
    return { number, repo, headBranch: j.head.ref, headSha: j.head.sha, baseBranch: j.base.ref,
      url: `https://github.com/${repo}/pull/${number}`, open: j.state === "open" };
  }
}
