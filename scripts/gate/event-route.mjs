#!/usr/bin/env node
// Issue #176 — trusted EVENT refresh for the quality gate. An event only WAKES the checker and selects candidate PRs; nothing in the
// payload (comment/body text, sha, labels) is an instruction or evidence. Targets are re-derived from LIVE API reads, the exact head SHA
// is the live one, and the checker (check.mjs) re-reads every evidence item itself. Runs from trusted BASE code, never PR code.
//   node scripts/gate/event-route.mjs   (reads GITHUB_EVENT_NAME / GITHUB_EVENT_PATH; --dry-run prints targets only)
import { readFileSync } from "node:fs";
import { createClient } from "../handoff/github.mjs";
import { reqFromPr } from "../handoff/lifecycle-evidence.mjs";
import { runCheck } from "./check.mjs";

export const STAGES = Object.freeze(["pre-pr", "final"]);
const SHA = /^[a-f0-9]{40}$/;
const posInt = (n) => Number.isInteger(n) && n > 0;

/**
 * Map an event to the PR numbers whose evidence MAY have changed. Pure over (event, live reads).
 *  - issue_comment on a PR            -> that PR (covers PR comments + Codex review-summary edits + receipt removal)
 *  - issue_comment / issues on an Issue -> every OPEN same-repo PR on an allowlisted base whose canonical linked issue is that Issue
 *  - pull_request_target                -> that PR
 *  - workflow_dispatch                  -> input pr
 * created / edited / deleted all map identically: the checker re-reads, so a removed receipt simply stops counting.
 * @returns {{targets:number[], skip?:string}}
 */
export async function targetsFromEvent({ name, payload, gh, allowlist }) {
  const ok = (pr) => pr && pr.state === "open" && pr.head?.repo?.full_name === pr.base?.repo?.full_name && allowlist.includes(pr.base?.ref);
  if (name === "workflow_dispatch") { const n = Number(payload?.inputs?.pr); return posInt(n) ? { targets: [n] } : { targets: [], skip: "invalid_dispatch_input" }; }
  if (name === "pull_request_target") { const n = payload?.pull_request?.number; return posInt(n) ? { targets: [n] } : { targets: [], skip: "invalid_pull_request" }; }
  if (name === "issue_comment" || name === "issues") {
    const n = payload?.issue?.number;
    if (!posInt(n)) return { targets: [], skip: "invalid_issue" };
    if (payload.issue.pull_request) return { targets: [n] };
    const open = await gh.listPulls();
    if (!Array.isArray(open)) throw new Error("listPulls returned a non-array");
    const t = open.filter((p) => ok(p) && reqFromPr(p) === n).map((p) => p.number);
    return t.length ? { targets: [...new Set(t)].sort((a, b) => a - b) } : { targets: [], skip: "no_linked_open_pr" };
  }
  return { targets: [], skip: "unsupported_event" };
}

/**
 * Wake -> validate -> (re)evaluate every target for BOTH stages. For each target the LIVE PR is read first: closed/fork/off-allowlist
 * PRs are skipped without writing; the exact SHA published is the live head (the payload SHA is only ever a hint for failures).
 */
export async function handleEvent({ name, payload, gh, allowlist, publish = true, check = runCheck, out = () => {} }) {
  const r = await targetsFromEvent({ name, payload, gh, allowlist });
  if (!r.targets.length) { out({ event: name, result: "skip", reason: r.skip }); return { results: [], skipped: r.skip }; }
  const results = [];
  for (const prNumber of r.targets) { // sequential per PR: one writer per PR, order-independent because each run re-reads live state
    let pr;
    try { pr = await gh.getPull(prNumber); } catch { pr = null; }
    if (pr && !ok_(pr, allowlist)) { out({ event: name, pr: prNumber, result: "skip", reason: "pr_out_of_scope" }); continue; }
    const expectedHead = SHA.test(pr?.head?.sha ?? "") ? pr.head.sha : (SHA.test(payload?.pull_request?.head?.sha ?? "") ? payload.pull_request.head.sha : undefined);
    for (const stage of STAGES) {
      const res = await check({ gh, prNumber, stage, publish, expectedHead });
      results.push({ pr: prNumber, stage, status: res.status, head: res.head, published: res.published, unmet: res.unmet });
      out({ event: name, pr: prNumber, stage, status: res.status, head: res.head, published: res.published, unmet: res.unmet });
    }
  }
  return { results };
}
const ok_ = (pr, allowlist) => pr.state === "open" && pr.head?.repo?.full_name === pr.base?.repo?.full_name && allowlist.includes(pr.base?.ref);

if (import.meta.url === `file://${process.argv[1]}`) {
  const allowlist = (process.env.QUALITY_GATE_ALLOWLIST ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!process.env.GITHUB_TOKEN || !allowlist.length) { console.error("GITHUB_TOKEN and QUALITY_GATE_ALLOWLIST required"); process.exit(2); }
  const gh = createClient({ token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY });
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const { results } = await handleEvent({ name: process.env.GITHUB_EVENT_NAME, payload, gh, allowlist, publish: !process.argv.includes("--dry-run"), out: (o) => console.log(JSON.stringify(o)) });
  process.exit(results.some((x) => x.published === false && !process.argv.includes("--dry-run")) ? 1 : 0);
}
