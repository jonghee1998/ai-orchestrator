import { normalizeIssues, type GitHubIssue, type WorkQueueTask } from "./work-queue";

const MAX_PAGES = 100;

export class GitHubQueueConfigurationError extends Error {}
export class GitHubQueueReadError extends Error {}

function repository(value: string): { owner: string; repo: string } | undefined {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value);
  return match ? { owner: match[1], repo: match[2] } : undefined;
}

export async function readGitHubWorkQueue(
  env: Readonly<Record<string, string | undefined>> = process.env,
  request: typeof fetch = fetch,
): Promise<WorkQueueTask[]> {
  const token = env.GITHUB_TOKEN?.trim();
  const target = repository(env.GITHUB_REPO?.trim() ?? "");
  if (!token || !target) {
    throw new GitHubQueueConfigurationError("GitHub work queue is not configured");
  }

  const issues: GitHubIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(
      `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/issues`,
    );
    url.searchParams.set("state", "all");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    let response: Response;
    try {
      response = await request(url, {
        cache: "no-store",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      throw new GitHubQueueReadError("GitHub work queue request failed");
    }
    if (!response.ok) {
      throw new GitHubQueueReadError(`GitHub work queue request failed (${response.status})`);
    }
    let pageIssues: GitHubIssue[];
    try {
      pageIssues = (await response.json()) as GitHubIssue[];
      if (!Array.isArray(pageIssues)) throw new Error("invalid payload");
    } catch {
      throw new GitHubQueueReadError("GitHub work queue returned an invalid response");
    }
    issues.push(...pageIssues);
    if (pageIssues.length < 100) return normalizeIssues(issues);
  }
  throw new GitHubQueueReadError("GitHub work queue exceeded the pagination limit");
}
