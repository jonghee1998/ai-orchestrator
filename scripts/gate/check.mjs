#!/usr/bin/env node
// Issue #174 — fail-closed quality-gate CHECK COMMAND for real PR CI. Reads complete GitHub evidence, runs the SAME evaluateGate,
// exits non-zero unless `pass`. Run from TRUSTED base-branch code (pull_request_target workflow), never from the PR's own checkout.
//   node scripts/gate/check.mjs --repo owner/name --pr N --stage pre-pr|final [--publish]
// --publish writes ONE commit status (context quality-gate/<stage>) on the PR head: pass=success, unknown=pending, blocked=failure.
import { createClient } from "../handoff/github.mjs";
import { reqFromPr } from "../handoff/lifecycle-evidence.mjs";
import { evaluateGate } from "./quality-gate.mjs";

const SHA = /^[a-f0-9]{40}$/;
const tag = (kind, o) => ({ kind, id: o.id ?? o.number, user: o.user, body: o.body ?? "", created_at: o.created_at, updated_at: o.updated_at });

/** Collect COMPLETE evidence; any gap (pagination bound, missing head, no commits) throws or yields unknown => never pass. */
export async function collectGateInput(gh, prNumber, stage) {
  const pr = await gh.getPull(prNumber);
  const head = pr.head?.sha;
  if (!SHA.test(head ?? "")) throw new Error("pr_head_unknown");
  const issue = reqFromPr(pr);
  if (!issue) return { unresolvable: "req_unresolvable" };
  const commits = await gh.listPullCommits(prNumber);
  const times = commits.map((c) => Date.parse(c?.commit?.committer?.date ?? "")).filter(Number.isFinite);
  // 250 is the API cap on this endpoint: a PR at/over it cannot be fully enumerated => time unknown (fail closed).
  const firstCodeCommitAt = commits.length > 0 && commits.length < 250 && times.length === commits.length ? new Date(Math.min(...times)).toISOString() : undefined;
  const issueObj = await gh.getIssue(issue);
  const items = [tag("issue", issueObj), tag("pr", pr), ...(await gh.listIssueComments(issue)).map((c) => tag("comment", c)), ...(await gh.listIssueComments(prNumber)).map((c) => tag("comment", c))]
    .map((it) => ({ ...it, trustedWriter: it.user?.id !== undefined && it.user?.id === pr.user?.id }));
  return { gate: { issue, pr: prNumber, head, items, firstCodeCommitAt, stage }, head };
}

const STATE = { pass: "success", unknown: "pending", blocked: "failure" };
export async function runCheck({ gh, prNumber, stage, publish = false }) {
  let res;
  try {
    const c = await collectGateInput(gh, prNumber, stage);
    res = c.unresolvable ? { status: "blocked", stages: {}, unmet: [c.unresolvable], head: null } : { ...evaluateGate(c.gate), head: c.head };
  } catch (e) { res = { status: "unknown", stages: {}, unmet: [`evidence_incomplete:${String(e.message).slice(0, 80)}`], head: null }; }
  if (publish && res.head) await gh.createCommitStatus(res.head, { state: STATE[res.status] ?? "failure", context: `quality-gate/${stage}`, description: res.status === "pass" ? "all required receipts verified" : `${res.status}: ${res.unmet.join(",")}` });
  return res;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const stage = arg("stage"), pr = Number(arg("pr")), repo = arg("repo") ?? process.env.GITHUB_REPOSITORY;
  if (!["pre-pr", "final"].includes(stage) || !Number.isInteger(pr) || !process.env.GITHUB_TOKEN) { console.error("usage: check.mjs --pr N --stage pre-pr|final [--repo o/r] [--publish] (GITHUB_TOKEN required)"); process.exit(2); }
  const res = await runCheck({ gh: createClient({ token: process.env.GITHUB_TOKEN, repo }), prNumber: pr, stage, publish: process.argv.includes("--publish") });
  console.log(JSON.stringify(res, null, 2));
  // With --publish the REQUIRED CHECK is the commit status; the job itself fails only when evidence is not `pass` too, so a red job is never green-washed.
  process.exit(res.status === "pass" ? 0 : 1);
}
