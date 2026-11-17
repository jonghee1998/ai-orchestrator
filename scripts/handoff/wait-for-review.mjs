#!/usr/bin/env node
// T6 read-only, bounded post-PR-open observation. Never creates comments/issues.
import { readFileSync } from "node:fs";
import { createClient } from "./github.mjs";
import { currentCodexState, codexReportObservation } from "./core.mjs";
import { run } from "./execute.mjs";

export async function observeReview(gh, number, { attempts = 9, intervalMs = 15000, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), out = console.log } = {}) {
  if (!Number.isInteger(number) || number <= 0) throw new Error("invalid PR");
  const initial = await gh.getPull(number);
  if (initial.state !== "open") return { result: "skip", reason: "pr_not_open" };
  const sha = initial.head?.sha;
  for (let i = 1; i <= attempts; i++) {
    const pr = await gh.getPull(number);
    if (pr.state !== "open" || pr.head?.sha !== sha) return { result: "skip", reason: "head_moved_or_pr_closed", sha };
    const comments = await gh.listIssueComments(number);
    const selected = currentCodexState(comments, sha);
    const marker = selected.codex;
    const observation = codexReportObservation(pr, comments);
    out(JSON.stringify({ step: "review_wait", pr: number, attempt: i, ...observation }));
    if (selected.conflict) return { result: "unverified", reason: "conflicting_codex_state", sha, writes: [] };
    if (marker?.commitSha === sha && marker.status === "completed") {
      // The coordinator itself re-reads live GitHub state; no persisted verdict is inferred.
      const verdict = await run(gh, number, { apply: false, repo: process.env.GITHUB_REPOSITORY || "jonghee1998/ai-orchestrator", log: (v) => out(JSON.stringify(v)) });
      const result = { result: "observed_structured", sha, verdict };
      out(JSON.stringify(result));
      return result;
    }
    if (i < attempts) await sleep(intervalMs);
  }
  const result = { result: "unverified", reason: "no_current_head_structured_review_before_deadline", sha, writes: [] };
  out(JSON.stringify(result));
  return result;
}

async function main() {
  if (process.env.GITHUB_EVENT_NAME !== "pull_request") return;
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const pr = payload.pull_request;
  if (!pr || pr.head?.repo?.full_name !== pr.base?.repo?.full_name || !Number.isInteger(pr.number)) return;
  const gh = createClient({ token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY });
  await observeReview(gh, pr.number);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exitCode = 1; });

