#!/usr/bin/env node
// Issue #174 — fail-closed quality-gate CHECK COMMAND for real PR CI. Reads complete GitHub evidence, runs the SAME evaluateGate,
// exits non-zero unless `pass`. Run from TRUSTED base-branch code (pull_request_target workflow), never from the PR's own checkout.
//   node scripts/gate/check.mjs --repo owner/name --pr N --stage pre-pr|final [--publish]
// --publish writes ONE commit status (context quality-gate/<stage>) on the PR head: pass=success, unknown=pending, blocked=failure.
import { createHash } from "node:crypto";
import { createClient } from "../handoff/github.mjs";
import { reqFromPr } from "../handoff/lifecycle-evidence.mjs";
import { resolveRoot } from "../handoff/lifecycle-run.mjs";
import { collectRootEvidence } from "../handoff/root-evidence.mjs";
import { resolveFailHistory } from "./fail-history.mjs";
import { evaluateGate } from "./quality-gate.mjs";
import { LOCK_GROUP } from "./pr-lock.mjs";
import { resolveCorrectionBoundary } from "./correction-boundary.mjs";

const SHA = /^[a-f0-9]{40}$/;
const tag = (kind, o) => ({ kind, id: o.id ?? o.number, user: o.user, body: o.body ?? "", created_at: o.created_at, updated_at: o.updated_at });

/** Never let a token or an upstream error body reach a commit-status description / log line (Issue #176). */
export const safeError = (e) => String(e?.message ?? e ?? "error")
  .replace(/(gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, "[redacted]").replace(/(bearer|token)\s+\S+/gi, "[redacted]").replace(/[\r\n]+/g, " ").slice(0, 80);

/**
 * Collect COMPLETE evidence for an ALREADY-FETCHED `pr` (its head is the identity of this run); any gap (pagination bound, no commits,
 * API/permission failure) throws or yields unresolvable => never pass. `fingerprint` changes whenever any evidence item is created,
 * edited or deleted, so a snapshot race (same SHA) is detectable before a green is published.
 */
export async function collectGateInput(gh, prNumber, stage, prIn, opts = {}) {
  const pr = prIn ?? await gh.getPull(prNumber);
  const head = pr.head?.sha;
  if (!SHA.test(head ?? "")) throw new Error("pr_head_unknown");
  const issue = reqFromPr(pr);
  if (!issue) return { unresolvable: "req_unresolvable", head };
  const issueObj = await gh.getIssue(issue);
  // Issue #182: first-code time = first commit NEW to THIS correction (verified superseded HEAD -> current HEAD boundary), never min(all PR commits).
  const commits = await gh.listPullCommits(prNumber);
  const bd = await resolveCorrectionBoundary({ gh, pr, linkedIssue: issueObj, commits, now: opts.now });
  if (bd.error) return { unresolvable: `boundary:${bd.error}`, head };
  const firstCodeCommitAt = bd.firstCodeCommitAt;
  const prComments = await gh.listIssueComments(prNumber);
  // Issue #178: ROOT-WIDE failure history. Unresolvable root / unreadable or partial enumeration THROWS or errors => blocked; never defaults to [].
  const rr = await resolveRoot(gh, issue);
  if (rr.error) return { unresolvable: rr.error, head };
  const base = await collectRootEvidence(gh, rr.root, { rootIssue: rr.root === issue ? issueObj : await gh.getIssue(rr.root), rootComments: await gh.listIssueComments(rr.root), pr, prComments });
  if (base.error) return { unresolvable: base.error, head };
  const fh = resolveFailHistory(base.items, rr.root);
  if (fh.error) return { unresolvable: fh.error, head };
  const items = [tag("issue", issueObj), tag("pr", pr), ...(await gh.listIssueComments(issue)).map((c) => tag("comment", c)), ...prComments.map((c) => tag("comment", c))]
    .map((it) => ({ ...it, trustedWriter: it.user?.id !== undefined && it.user?.id === pr.user?.id }));
  // RCA receipts may live anywhere in the root (trusted-PM only is enforced by the evaluator); add root items not already present.
  const have = new Set(items.map((i) => `${i.kind}:${i.id}`));
  for (const r of base.items) if (!have.has(`${r.kind === "pr-comment" ? "comment" : r.kind}:${r.id}`)) items.push({ ...r, kind: r.kind, updated_at: r.updated_at ?? r.created_at, trustedWriter: false });
  const fingerprint = createHash("sha256").update(JSON.stringify([head, firstCodeCommitAt ?? null, rr.root, bd.source ?? null, fh.records.map((r) => [r.class, r.pr, r.sha]).sort(), items.map((i) => [i.kind, i.id, i.user?.id ?? null, i.created_at ?? null, i.updated_at ?? null, i.body])])).digest("hex");
  return { gate: { issue, root: rr.root, pr: prNumber, head, items, firstCodeCommitAt, stage, failHistory: fh.failHistory }, head, fingerprint };
}

const STATE = { pass: "success", unknown: "pending", blocked: "failure" };

/**
 * Issue #176 — fail-closed STATUS lifecycle for ONE stage context on ONE exact head:
 *   1 resolve PR + HEAD (or trusted event `expectedHead`) BEFORE any evidence read;  2 invalidate any earlier success as `pending`;
 *   3 collect evidence (every failure => `failure` on the known SHA, never a skipped write);  4 for a `pass`, re-collect and compare the
 *   fingerprint + HEAD (snapshot race => `pending`, moved HEAD => nothing published, never green);  5 publish; a failed write is reported.
 * Returns {status, unmet, head, invalidated, published, publishError?}. `status:"pass"` only when the success status was really written
 * (or no publish was requested). Nothing here reports a successful invalidation/publication when the write failed.
 */
export async function runCheck({ gh, prNumber, stage, publish = false, expectedHead, now }) {
  const context = `quality-gate/${stage}`;
  const res = { status: "blocked", stages: {}, unmet: [], head: null, invalidated: false, published: false };
  const write = async (sha, state, description) => {
    try { await gh.createCommitStatus(sha, { state, context, description }); return { ok: true }; }
    catch (e) { return { ok: false, error: safeError(e) }; }
  };
  // 1. identity first
  let pr = null;
  try { pr = await gh.getPull(prNumber); } catch (e) { res.unmet.push(`pr_fetch_failed:${safeError(e)}`); }
  const live = SHA.test(pr?.head?.sha ?? "") ? pr.head.sha : null;
  const head = live ?? (SHA.test(expectedHead ?? "") ? expectedHead : null);
  if (!head) { res.unmet.push("pr_head_unknown"); return res; } // cannot name a SHA => nothing can be written; reported BLOCKED
  res.head = head;
  if (!live) res.unmet.push("head_from_event_only");
  // 2. invalidate before any downstream read
  if (publish) {
    const inv = await write(head, "pending", "re-evaluating evidence");
    if (!inv.ok) return { ...res, unmet: [...res.unmet, "invalidation_failed"], publishError: inv.error };
    res.invalidated = true;
  }
  const finish = async (state, outcome, description) => {
    if (publish) {
      const w = await write(head, state, description);
      if (!w.ok) return { ...res, ...outcome, status: "blocked", unmet: [...outcome.unmet, "publish_failed"], publishError: w.error };
      res.published = true;
    }
    return { ...res, ...outcome };
  };
  // 3. collect
  let c;
  if (!live) return finish("failure", { status: "blocked", unmet: [...res.unmet, "evidence_incomplete:pr_unreadable"] }, "blocked: pr_unreadable");
  try { c = await collectGateInput(gh, prNumber, stage, pr, { now }); }
  catch (e) { return finish("failure", { status: "blocked", unmet: [`evidence_incomplete:${safeError(e)}`] }, "blocked: evidence_incomplete"); }
  if (c.unresolvable) return finish("failure", { status: "blocked", unmet: [c.unresolvable] }, `blocked: ${c.unresolvable}`);
  const ev = evaluateGate(c.gate);
  if (ev.status !== "pass") return finish(STATE[ev.status] ?? "failure", { status: ev.status, stages: ev.stages, unmet: ev.unmet }, `${ev.status}: ${ev.unmet.join(",")}`);
  // 4. a green must survive a second, later read of HEAD + every evidence item
  let again;
  try { again = await collectGateInput(gh, prNumber, stage, undefined, { now }); }
  catch (e) { return finish("failure", { status: "blocked", unmet: [`evidence_incomplete:${safeError(e)}`] }, "blocked: evidence_incomplete"); }
  if (again.head !== head) return { ...res, status: "blocked", stages: ev.stages, unmet: ["stale_head"] }; // newer run owns the new HEAD; never green it
  if (again.unresolvable || again.fingerprint !== c.fingerprint) return finish("pending", { status: "unknown", stages: ev.stages, unmet: ["evidence_changed_during_check"] }, "unknown: evidence_changed_during_check");
  return finish("success", { status: "pass", stages: ev.stages, unmet: [] }, "all required receipts verified");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const stage = arg("stage"), pr = Number(arg("pr")), repo = arg("repo") ?? process.env.GITHUB_REPOSITORY;
  if (!["pre-pr", "final"].includes(stage) || !Number.isInteger(pr) || !process.env.GITHUB_TOKEN) { console.error("usage: check.mjs --pr N --stage pre-pr|final [--repo o/r] [--publish] (GITHUB_TOKEN required)"); process.exit(2); }
  // Issue #180: a publishing run must hold the per-PR lock domain (job concurrency group quality-gate-pr-<N>); direct unlocked publish is refused.
  if (process.argv.includes("--publish") && process.env.QUALITY_GATE_PR_LOCK !== LOCK_GROUP(pr)) { console.error(`refusing --publish without lock marker ${LOCK_GROUP(pr)}`); process.exit(2); }
  const res = await runCheck({ gh: createClient({ token: process.env.GITHUB_TOKEN, repo }), prNumber: pr, stage, publish: process.argv.includes("--publish"), expectedHead: arg("head") });
  console.log(JSON.stringify(res, null, 2));
  // With --publish the REQUIRED CHECK is the commit status; the job fails unless evidence is `pass` AND the success status was really written.
  process.exit(res.status === "pass" ? 0 : 1);
}
