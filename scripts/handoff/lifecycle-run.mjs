// Issue #138 — dry-run lifecycle wiring. Loads real normalized GitHub evidence through a READ-ONLY facade,
// plans, and returns the plan. Never writes, never enables live mode.
import { linkedIssueNumbers } from "./core.mjs";
import { planLifecycle, parseConfig, allRecords, MAX_ROUNDS } from "./lifecycle.mjs";
import { normalizeCodexReviews, pmAcceptMarkers, pmRevises, ciFromCheckRuns, deploymentFromCommitStatus, ancestryFrom, tipFrom, reqFromPr, rootMarker, supersedesMarker } from "./lifecycle-evidence.mjs";

const READ_ONLY = ["getPull", "getIssue", "listIssueComments", "getCommit", "getBranch", "compare", "listCheckRuns", "getCombinedStatus"];
export const readOnly = (gh) => Object.fromEntries(READ_ONLY.map((k) => [k, (...a) => gh[k](...a)]));

export function configFromEnv(env = process.env) {
  const list = (env.HANDOFF_LIFECYCLE_ALLOWLIST ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return parseConfig({ allowlist: list, expectedBase: env.HANDOFF_LIFECYCLE_EXPECTED_BASE });
}

const MAX_ROOT_HOPS = 5;
/** F3: follow `orch-root-request` markers from the linked (revision) issue to the canonical root request. Cycles/ambiguity fail closed. */
export async function resolveRoot(gh, linked) {
  const seen = new Set();
  let n = linked;
  for (let hop = 0; hop <= MAX_ROOT_HOPS; hop++) {
    if (seen.has(n)) return { error: "root_request_cycle" };
    seen.add(n);
    const m = rootMarker(await gh.getIssue(n));
    if (m === "ambiguous") return { error: "root_request_ambiguous" };
    if (m === null || m === n) return { root: n, chain: [...seen] };
    n = m;
  }
  return { error: "root_request_chain_too_deep" };
}

const mergeById = (...lists) => { const seen = new Set(); return lists.flat().filter((c) => (c?.id === undefined || !seen.has(c.id)) && (seen.add(c?.id), true)); };

/** Round = 1 + number of distinct rounds already closed out by a `revise` done record for this request. */
export const roundFor = (comments, req) => {
  const done = new Set(allRecords(comments).filter((r) => r.parsed.req === req && r.parsed.step === "revise" && r.state === "done").map((r) => r.parsed.round));
  return Math.min(done.size + 1, MAX_ROUNDS + 1);
};

/** @returns the dry-run plan (always mode:"dry-run", live:false). Any load/shape failure fails closed as `blocked`. */
export async function runLifecycle(ghFull, prNumber, { config, expectedHead, log = () => {} } = {}) {
  const gh = readOnly(ghFull);
  const cfg = config ?? { ok: false, reason: "config_missing" };
  const fail = (reason, detail) => ({ mode: "dry-run", live: false, writes: [], action: "blocked", reason, ...(detail ? { detail } : {}) });
  if (!cfg.ok) return fail(`config_${cfg.reason}`.replace("config_config_", "config_"));
  try {
    const pr = await gh.getPull(prNumber);
    const linked = reqFromPr(pr);
    if (!linked) return fail("req_unresolvable", { refs: linkedIssueNumbers(pr) });
    // F3: canonical root request; durable records/rounds are read from the ROOT issue + this PR (+ the superseded PR), not just this PR.
    const rootRes = await resolveRoot(gh, linked);
    if (rootRes.error) return fail(rootRes.error, { linked });
    const req = rootRes.root;
    // F8: superseded PR (replacement chain) loaded and ancestry-verified here, through the real entrypoint.
    const sm = supersedesMarker(pr);
    if (sm === "ambiguous") return fail("supersedes_ambiguous");
    const superseded = sm ? await gh.getPull(sm) : undefined;
    const ancestry = superseded ? ancestryFrom(superseded.head?.sha, pr.head?.sha, await gh.compare(superseded.head?.sha, pr.head?.sha)) : undefined;
    const prComments = await gh.listIssueComments(prNumber);
    const rootComments = req === prNumber ? [] : await gh.listIssueComments(req);
    const oldComments = superseded ? await gh.listIssueComments(superseded.number) : [];
    const comments = mergeById(rootComments, oldComments, prComments);
    const reviews = normalizeCodexReviews(comments);
    // Expected head: explicit (event/dispatch) else the exact SHA of the trusted Codex verdict being acted on.
    const head = expectedHead ?? reviews.at(-1)?.commit_sha;
    const input = {
      req, round: roundFor(comments, req), config: cfg, integrationTarget: pr.base?.ref, pr, expectedHead: head, reviews, superseded, ancestry,
      acceptIssues: [...new Set([req, linked])],
      pmAccepts: pmAcceptMarkers(comments), pmRevises: pmRevises(comments), records: comments,
    };
    if (pr.merged !== true && cfg.allowlist.includes(pr.base?.ref) && /^[a-f0-9]{40}$/.test(pr.base?.sha ?? "")) {
      // F1: base must be an ancestor of the LIVE integration tip (no hardcoded SHA).
      const branch = await gh.getBranch(pr.base.ref);
      const tipSha = branch?.commit?.sha;
      input.tip = /^[a-f0-9]{40}$/.test(tipSha ?? "") ? tipFrom(pr.base.sha, branch, await gh.compare(pr.base.sha, tipSha)) : null;
    }
    if (pr.merged === true && /^[a-f0-9]{40}$/.test(pr.merge_commit_sha ?? "")) {
      const mergeSha = pr.merge_commit_sha;
      const [commit, tip, headToMerge] = await Promise.all([
        gh.getCommit(mergeSha),
        gh.getBranch(pr.base.ref),
        gh.compare(pr.head.sha, mergeSha),
      ]);
      const tipCmp = await gh.compare(mergeSha, tip?.commit?.sha);
      const [checks, combined] = await Promise.all([gh.listCheckRuns(mergeSha), gh.getCombinedStatus(mergeSha)]);
      const parents = Array.isArray(commit?.parents) ? commit.parents.length : 0;
      const a = ancestryFrom(pr.head.sha, mergeSha, headToMerge);
      input.merge = {
        sha: commit?.sha,
        tipContainsMerge: ["ahead", "identical"].includes(ancestryFrom(mergeSha, tip?.commit?.sha, tipCmp).status),
        headContained: parents >= 2 ? ["ahead", "identical"].includes(a.status) : "squash",
      };
      input.ci = ciFromCheckRuns(mergeSha, checks);
      input.deployment = deploymentFromCommitStatus(mergeSha, combined);
    }
    const plan = planLifecycle(input);
    log({ step: "lifecycle_plan", pr: prNumber, plan });
    return plan;
  } catch (e) {
    return fail("evidence_load_failed", { message: String(e.message).slice(0, 200) });
  }
}
