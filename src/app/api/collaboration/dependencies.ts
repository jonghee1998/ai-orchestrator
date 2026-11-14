import { getRunStore } from "@/lib/runs/store";
import { GitHubLabelAdapter } from "@/lib/runs/dispatcher";
import { GitHubEvidenceReader } from "@/lib/runs/collaboration-github";
import type { RunStore } from "@/lib/runs/store";
let shared: { key: string; store: RunStore } | undefined;
export function dependencies() {
  const repo = process.env.GITHUB_REPO?.trim() ?? "", token = process.env.GITHUB_TOKEN?.trim() ?? "";
  const store = () => {
    const key = JSON.stringify([process.env.DATABASE_URL, process.env.RUN_STORE_PATH, process.env.VERCEL, process.env.AWS_LAMBDA_FUNCTION_NAME, process.env.NETLIFY, process.env.K_SERVICE]);
    if (!shared || shared.key !== key) shared = { key, store: getRunStore() };
    return shared.store;
  };
  return { store, github: new GitHubEvidenceReader(repo, process.env.GITHUB_READ_TOKEN?.trim() || token),
    adapter: new GitHubLabelAdapter({ repo, token }), env: process.env, nowMs: Date.now() };
}
