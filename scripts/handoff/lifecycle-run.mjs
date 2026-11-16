// Issue #138 — dry-run lifecycle wiring. Loads real normalized GitHub evidence through a READ-ONLY facade,
// plans, and returns the plan. Never writes, never enables live mode.
import { linkedIssueNumbers } from "./core.mjs";
import { planLifecycle, parseConfig, allRecords, MAX_ROUNDS } from "./lifecycle.mjs";
import { normalizeCodexReviews, pmAcceptMarkers, pmRevises, ciFromCheckRuns, deploymentFromApi, ancestryFrom, reqFromPr } from "./lifecycle-evidence.mjs";

const READ_ONLY = ["getPull", "getIssue", "listIssueComments", "getCommit", "getBranch", "compare", "listCheckRuns", "listDeployments", "listDeploymentStatuses"];
export const readOnly = (gh) => Object.fromEntries(READ_ONLY.map((k) => [k, (...a) => gh[k](...a)]));

export function configFromEnv(env = process.env) {
  const list = (env.HANDOFF_LIFECYCLE_ALLOWLIST ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return parseConfig({ allowlist: list, expectedBase: env.HANDOFF_LIFECYCLE_EXPECTED_BASE });
}

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
    const req = reqFromPr(pr);
    if (!req) return fail("req_unresolvable", { refs: linkedIssueNumbers(pr) });
    const comments = await gh.listIssueComments(prNumber);
    const reviews = normalizeCodexReviews(comments);
    // Expected head: explicit (event/dispatch) else the exact SHA of the trusted Codex verdict being acted on.
    const head = expectedHead ?? reviews.at(-1)?.commit_sha;
    const input = {
      req, round: roundFor(comments, req), config: cfg, integrationTarget: pr.base?.ref, pr, expectedHead: head, reviews,
      pmAccepts: pmAcceptMarkers(comments), pmRevises: pmRevises(comments), records: comments,
    };
    if (pr.merged === true && /^[a-f0-9]{40}$/.test(pr.merge_commit_sha ?? "")) {
      const mergeSha = pr.merge_commit_sha;
      const [commit, tip, headToMerge] = await Promise.all([
        gh.getCommit(mergeSha),
        gh.getBranch(pr.base.ref),
        gh.compare(pr.head.sha, mergeSha),
      ]);
      const tipCmp = await gh.compare(mergeSha, tip?.commit?.sha);
      const [checks, deps] = await Promise.all([gh.listCheckRuns(mergeSha), gh.listDeployments(mergeSha)]);
      const statuses = {};
      for (const d of Array.isArray(deps) ? deps : []) statuses[d.id] = await gh.listDeploymentStatuses(d.id);
      const parents = Array.isArray(commit?.parents) ? commit.parents.length : 0;
      const a = ancestryFrom(pr.head.sha, mergeSha, headToMerge);
      input.merge = {
        sha: commit?.sha,
        tipContainsMerge: ["ahead", "identical"].includes(ancestryFrom(mergeSha, tip?.commit?.sha, tipCmp).status),
        headContained: parents >= 2 ? ["ahead", "identical"].includes(a.status) : "squash",
      };
      input.ci = ciFromCheckRuns(mergeSha, checks);
      input.deployment = deploymentFromApi(mergeSha, deps, statuses);
    }
    const plan = planLifecycle(input);
    log({ step: "lifecycle_plan", pr: prNumber, plan });
    return plan;
  } catch (e) {
    return fail("evidence_load_failed", { message: String(e.message).slice(0, 200) });
  }
}
