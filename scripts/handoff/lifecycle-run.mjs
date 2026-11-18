// Issue #138 — dry-run lifecycle wiring. Loads real normalized GitHub evidence through a READ-ONLY facade,
// plans, and returns the plan. Never writes, never enables live mode.
import { linkedIssueNumbers } from "./core.mjs";
import { planLifecycle, parseConfig, allRecords, MAX_ROUNDS } from "./lifecycle.mjs";
import { collectRootEvidence, addChainEvidence, deriveChainCorrection } from "./root-evidence.mjs";
import { resolveRootCorrections, correctionRound, resolveCorrectionLimit } from "./root-corrections.mjs";
import { normalizeCodexReviews, pmAcceptMarkers, pmRevises, ciFromCheckRuns, deploymentFromCommitStatus, ancestryFrom, tipFrom, reqFromPr, rootMarker, supersedesMarker } from "./lifecycle-evidence.mjs";

const READ_ONLY = ["getPull", "getIssue", "listIssueComments", "listIssues", "listPulls", "getCommit", "getBranch", "compare", "listCheckRuns", "getCombinedStatus"];
export const readOnly = (gh) => Object.fromEntries(READ_ONLY.map((k) => [k, (...a) => gh[k](...a)]));

export function configFromEnv(env = process.env) {
  const list = (env.HANDOFF_LIFECYCLE_ALLOWLIST ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return parseConfig({ allowlist: list, expectedBase: env.HANDOFF_LIFECYCLE_EXPECTED_BASE });
}

/**
 * Canonical root request (Issue #144). The linked issue MUST carry an explicit trusted root marker, and the root it
 * names MUST carry a trusted SELF marker (`#<root>` on issue <root>). Missing / ambiguous / non-self-terminating
 * markers fail closed; nothing falls back to "the linked issue is its own root".
 */
export async function resolveRoot(gh, linked) {
  const m = rootMarker(await gh.getIssue(linked));
  if (m === "ambiguous") return { error: "root_request_ambiguous", detail: { issue: linked } };
  if (m === null) return { error: "root_marker_missing", detail: { issue: linked } };
  if (m !== linked) {
    const rm = rootMarker(await gh.getIssue(m));
    if (rm === "ambiguous") return { error: "root_request_ambiguous", detail: { issue: m } };
    if (rm !== m) return { error: "root_not_self_marked", detail: { root: m } };
  }
  return { root: m };
}

/**
 * Verified replacement chain (Issue #144): from `pr` follow `orch-supersedes:v1 pr<N>` until an explicit `none`.
 * Every member must have a trusted marker (missing/ambiguous/cycle => fail closed) and every member's linked issue
 * must resolve to the SAME root. Bounded to MAX_ROUNDS + 2 PRs (original + MAX_ROUNDS revisions + one over-cap probe).
 * @returns {{chain:object[], error?:string, detail?:object}} chain[0] = pr, last = original PR.
 */
export async function resolveChain(gh, pr, root, maxRounds = MAX_ROUNDS) {
  const chain = [pr];
  const seen = new Set([pr.number]);
  for (let cur = pr; ; ) {
    const m = supersedesMarker(cur);
    if (m === null) return { chain, error: "supersedes_marker_missing", detail: { pr: cur.number } };
    if (m === "ambiguous") return { chain, error: "supersedes_ambiguous", detail: { pr: cur.number } };
    if (m === "none") break;
    if (seen.has(m)) return { chain, error: "supersedes_cycle", detail: { pr: m } };
    if (chain.length >= maxRounds + 2) return { chain, error: "round_cap_exceeded", detail: { max: maxRounds } };
    const next = await gh.getPull(m);
    if (!next || next.number !== m) return { chain, error: "superseded_unavailable", detail: { pr: m } };
    seen.add(m); chain.push(next); cur = next;
  }
  for (const p of chain.slice(1)) {
    const l = reqFromPr(p);
    const r = l ? await resolveRoot(gh, l) : { error: "req_unresolvable" };
    if (r.error || r.root !== root) return { chain, error: "chain_root_mismatch", detail: { pr: p.number, ...(r.root ? { root: r.root } : {}) } };
  }
  return { chain };
}

const mergeById = (...lists) => { const seen = new Set(); return lists.flat().filter((c) => (c?.id === undefined || !seen.has(c.id)) && (seen.add(c?.id), true)); };

/**
 * Round semantics (Issue #144). The ORIGINAL PR of a chain (`supersedes none`) is round 1 (initial work, no revision).
 * Each replacement PR is one revision: round = number of revision PRs in the verified chain, so PR137 (original) = r1,
 * PR139 (rev 1) = r1, PR142 (rev 2) = r2, the #144 PR (rev 3) = r3. MAX_ROUNDS = 3 revisions; a 4th revision PR
 * (depth 4) is `round_cap_exceeded`. The round is the MAX of the chain-derived depth and the durable bot records
 * (closed-out `revise` rounds + 1), so neither source alone can lower it, and a remediation never resets the count.
 */
export const roundFor = (comments, req, chainDepth = 0, maxRounds = MAX_ROUNDS) => {
  const done = new Set(allRecords(comments).filter((r) => r.parsed.req === req && r.parsed.step === "revise" && r.state === "done").map((r) => r.parsed.round));
  return Math.min(Math.max(chainDepth, done.size + 1, 1), maxRounds + 1);
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
    if (rootRes.error) return fail(rootRes.error, { linked, ...rootRes.detail });
    const req = rootRes.root;
    // Issue #144: explicit verified chain (supersedes marker or explicit `none`, same root all the way down).
    // Issue #166: root-specific correction limit (default 3, trusted PM marker may raise to <=5) from root issue + root comments.
    const rootIssue = await gh.getIssue(req);
    const rootComments = await gh.listIssueComments(req);
    const prComments = await gh.listIssueComments(prNumber);
    // Issue #172: ROOT-WIDE evidence (all root-marked issues/PRs of every chain, bodies AND comments), not just the current chain.
    const base = await collectRootEvidence(gh, req, { rootIssue, rootComments, pr, prComments });
    if (base.error) return fail(base.error, base.detail);
    const lim = resolveCorrectionLimit(base.items, req);
    if (lim.error) return fail(lim.error, lim.detail);
    const maxRounds = lim.max;
    const ch = await resolveChain(gh, pr, req, maxRounds);
    if (ch.error) return fail(ch.error, ch.detail);
    const depth = ch.chain.length - 1; // revision PRs in the chain
    const superseded = ch.chain[1];
    // Issue #156: bind exact-SHA ancestry for EVERY adjacent link (chain[i+1].head -> chain[i].head).
    const chainLinks = await Promise.all(ch.chain.slice(0, -1).map(async (newer, i) => {
      const older = ch.chain[i + 1];
      return { newer, older, ancestry: ancestryFrom(older.head?.sha, newer.head?.sha, await gh.compare(older.head?.sha, newer.head?.sha)) };
    }));
    const ancestry = chainLinks[0]?.ancestry;
    const ev = await addChainEvidence(gh, base, ch.chain);
    // Durable records: every PR comment of the verified chain (bounded), merged by comment id (legacy shape used by the planner).
    const commentsByPr = { [prNumber]: prComments };
    for (const p of ch.chain.slice(1)) commentsByPr[p.number] = await gh.listIssueComments(p.number);
    const comments = mergeById(rootComments, ...ch.chain.slice(1).map((p) => commentsByPr[p.number]), prComments);
    const reviews = normalizeCodexReviews(comments);
    // Expected head: explicit (event/dispatch) else the exact SHA of the trusted Codex verdict being acted on.
    const head = expectedHead ?? reviews.filter((r) => !r.ambiguous).at(-1)?.commit_sha;
    // Issue #161/#172: durable ROOT-level correction counter (spans separate chains of the same root; never lowered).
    const request = superseded?.head?.sha ? { pr: superseded.number, sha: superseded.head.sha } : null;
    const first = resolveRootCorrections(ev.items, req, maxRounds, { request: null });
    if (first.error) return fail(first.error, first.detail);
    const dv = deriveChainCorrection({ chain: ch.chain, chainLinks, records: first.records, commentsByPr });
    if (dv.error) return fail(dv.error, dv.detail);
    const resolved = resolveRootCorrections(ev.items, req, maxRounds, { request, derived: dv.derived ? [dv.derived] : [] });
    const rc = correctionRound({ resolved, prNumber, chainDepth: depth, floor: roundFor(comments, req, depth, maxRounds), limit: maxRounds });
    if (rc.error) return fail(rc.error, rc.detail);
    const input = {
      req, round: rc.round, maxRounds, config: cfg, integrationTarget: pr.base?.ref, pr, expectedHead: head, reviews, superseded, ancestry, chainLinks,
      acceptIssues: [...new Set([req, linked])],
      pmAccepts: pmAcceptMarkers(comments), pmRevises: pmRevises(comments), records: comments,
    };
    if (pr.merged !== true && cfg.allowlist.includes(pr.base?.ref) && /^[a-f0-9]{40}$/.test(pr.base?.sha ?? "")) {
      // F1: base must be an ancestor of the LIVE integration tip (no hardcoded SHA).
      const branch = await gh.getBranch(pr.base.ref);
      const tipSha = branch?.commit?.sha;
      input.tip = /^[a-f0-9]{40}$/.test(tipSha ?? "") ? tipFrom(pr.base.sha, branch, await gh.compare(pr.base.sha, tipSha)) : null;
    }
    if (pr.merged !== true) {
      // Issue #161: same-SHA CI for the OPEN head, needed before awaiting_user_approval (separate from merge-SHA CI).
      input.headCi = ciFromCheckRuns(pr.head.sha, await gh.listCheckRuns(pr.head.sha));
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
