#!/usr/bin/env node
// Issue #176 — trusted EVENT refresh for the quality gate. An event only WAKES the checker and selects candidate PRs; nothing in the
// payload (comment/body text, sha, labels) is an instruction or evidence. Targets are re-derived from LIVE API reads, the exact head SHA
// is the live one, and the checker (check.mjs) re-reads every evidence item itself. Runs from trusted BASE code, never PR code.
//   node scripts/gate/event-route.mjs   (reads GITHUB_EVENT_NAME / GITHUB_EVENT_PATH; --dry-run prints targets only)
import { readFileSync, appendFileSync } from "node:fs";
import { createClient } from "../handoff/github.mjs";
import { reqFromPr, rootMarker } from "../handoff/lifecycle-evidence.mjs";
import { resolveRoot } from "../handoff/lifecycle-run.mjs";
import { LOCK_GROUP, defaultPrLock } from "./pr-lock.mjs";
import { runCheck } from "./check.mjs";

export const STAGES = Object.freeze(["pre-pr", "final"]);
const SHA = /^[a-f0-9]{40}$/;
const posInt = (n) => Number.isInteger(n) && n > 0;

const ELIGIBLE = (pr, allowlist) => pr && pr.state === "open" && pr.head?.repo?.full_name === pr.base?.repo?.full_name && allowlist.includes(pr.base?.ref);
const UNRELATED = new Set(["root_marker_missing", "req_unresolvable"]);
const MATRIX_LIMIT = 256; // GitHub Actions matrix cap
const STALE_NOTE = "quality-gate/* statuses of open PRs outside this run's targets may remain stale (previous success NOT invalidated)";

/**
 * Issue #180 — ROOT-AWARE fan-out. Evidence is root-wide (check.mjs/collectRootEvidence), so an event on ANY root evidence source
 * (root issue, sibling revision issue, sibling/historical PR body or comment — created/edited/deleted) must refresh EVERY eligible open
 * PR that shares the event source's root. Pure over (event, live reads); the payload only WAKES/selects, it never supplies a root or SHA.
 *   - the event source's root is re-derived from live reads through the verified lineage (resolveRoot: linked issue -> trusted root marker ->
 *     self-marked root); a PR event also contributes the root named by the PR's own marker (verified the same way)
 *   - candidates: open, same-repo, allowlisted-base PRs whose OWN linked issue resolves (live) to one of those roots; plus PRs directly linked
 *     to the event issue; the event PR itself is always a target (its own check fails closed if unresolvable)
 *   - a source root that is ambiguous / not self-marked / un-enumerable => {error} (fail closed, concrete diagnostic), never silent-empty.
 *     A sibling PR whose own lineage is unresolvable cannot be attributed to the root; it fails closed in its own check and is only listed
 *     in `diagnostics`. A source with no root marker at all is unrelated (explicit skip reason, not an error).
 * workflow_dispatch / pull_request_target targets stay the single named PR (pull_request_target is routed through the same plan, see
 * rootsForPr use below: a PR body edit is root evidence for siblings, so it fans out too).
 * @returns {{targets:number[], skip?:string, error?:string, detail?:object, roots?:number[], diagnostics?:object[]}}
 */
export async function targetsFromEvent({ name, payload, gh, allowlist }) {
  if (name === "workflow_dispatch") { const n = Number(payload?.inputs?.pr); return posInt(n) ? { targets: [n] } : { targets: [], skip: "invalid_dispatch_input" }; }
  const isIssueEvt = name === "issue_comment" || name === "issues";
  if (!isIssueEvt && name !== "pull_request_target") return { targets: [], skip: "unsupported_event" };
  const n = isIssueEvt ? payload?.issue?.number : payload?.pull_request?.number;
  if (!posInt(n)) return { targets: [], skip: isIssueEvt ? "invalid_issue" : "invalid_pull_request" };
  const eventIsPr = !isIssueEvt || !!payload.issue.pull_request;
  const diagnostics = [];
  const cache = new Map();
  const rootOf = async (issueNo) => {
    if (!cache.has(issueNo)) cache.set(issueNo, await resolveRoot(gh, issueNo));
    return cache.get(issueNo);
  };
  // Issue #182: enumerate FIRST. If even the conservative superset (every eligible open PR) cannot be listed, nothing can be invalidated =>
  // explicit BLOCKED naming what may stay stale. Never a silent skip, never a claim of safety.
  let allPulls; // ALL states (open + closed history), not only open PRs
  try { allPulls = await gh.listPulls(); if (!Array.isArray(allPulls)) throw new Error("listPulls returned a non-array"); }
  catch (e) {
    return { targets: eventIsPr ? [n] : [], blocked: true, error: "pr_enumeration_failed", detail: { message: String(e?.message ?? e).slice(0, 80) }, stale: STALE_NOTE, diagnostics };
  }
  const eligible = allPulls.filter((p) => ELIGIBLE(p, allowlist));
  const superset = () => [...new Set([...(eventIsPr ? [n] : []), ...eligible.map((p) => p.number)])].sort((a, b) => a - b);
  const capped = (r) => {
    if (r.targets.length <= MATRIX_LIMIT) return r;
    return { ...r, targets: r.targets.slice(0, MATRIX_LIMIT), blocked: true, error: "target_set_exceeds_matrix_limit", stale: `${STALE_NOTE} (not refreshed: ${r.targets.slice(MATRIX_LIMIT, MATRIX_LIMIT + 50).join(",")}${r.targets.length > MATRIX_LIMIT + 50 ? ",…" : ""})` };
  };
  try {
    const roots = new Set();
    const direct = new Set(eventIsPr ? [n] : []);
    const lost = [];
    let formerProven = false; // true once a movable event's former root(s) were derived and verified independently of `lost`
    const addRoot = async (issueNo, what) => {
      const r = await rootOf(issueNo);
      // Issue #184: a MISSING current marker is NOT proof of unrelatedness (the marker may be exactly what was just edited/deleted).
      // Record the lost source; it is recovered from independently verified history below or falls back to the conservative superset.
      if (r.error) { if (UNRELATED.has(r.error)) { lost.push({ source: what, issue: issueNo, error: r.error }); return null; } throw Object.assign(new Error(r.error), { detail: { ...r.detail, source: what } }); }
      roots.add(r.root);
      return r.root;
    };
    // Issue #188: OLD-ROOT / NEW-ROOT UNION. A current valid root is NOT proof of the former root: an event that can change attribution
    // (issue edited/deleted/unknown action, PR edited/unknown action) refreshes dependents(old) UNION dependents(new). Former roots come from
    // (a) payload `changes.body.from` - a CANDIDATE only (never instruction/evidence/PASS), each verified live through resolveRoot; and
    // (b) independent live history: every PR (any state) linked to the issue, or carrying a trusted marker naming it. Neither source =>
    // previous_root_unprovable => conservative superset. Ambiguous / unverifiable prior => superset.
    const act = payload?.action;
    const canMove = isIssueEvt ? (name === "issues" && act !== "opened") : act !== "opened" && act !== "reopened" && act !== "synchronize" && act !== "ready_for_review";
    const prevBody = payload?.changes?.body?.from;
    const former = async (issueNo, owner, what) => {
      let present = false;
      const cur = new Set(issueNo === null ? [] : [issueNo]); // issues whose PR history is scanned: the CURRENT link ...
      const prior = new Set(); // ... and the payload-PRIOR link (history of the CURRENT link only describes the NEW side when the link moved)
      const addVerified = async (m, src) => {
        if (m === "ambiguous") throw Object.assign(new Error("previous_root_ambiguous"), { detail: { source: what } });
        if (!Number.isInteger(m)) return;
        const r = await rootOf(m);
        if (r.error) throw Object.assign(new Error("previous_root_unverifiable"), { detail: { source: what, via: src, why: r.error } });
        roots.add(r.root); diagnostics.push({ source: what, formerRoot: r.root, via: src });
      };
      if (typeof prevBody === "string") { const pm = rootMarker({ user: owner, body: prevBody }); present = Number.isInteger(pm) || (!/orch-root-request:v1/.test(prevBody) && (!eventIsPr || !reqFromPr({ user: owner, body: prevBody }))); /* a prior that names a root but is not verifiable (untrusted author / forged) is NOT proof of "was unmarked" */ await addVerified(pm, "payload_prior"); const pl = reqFromPr({ user: owner, body: prevBody }); if (pl && pl !== issueNo) { prior.add(pl); const r = await rootOf(pl); if (r.error) throw Object.assign(new Error("previous_root_unverifiable"), { detail: { source: what, via: "payload_prior_link", why: r.error } }); roots.add(r.root); diagnostics.push({ source: what, formerRoot: r.root, via: "payload_prior_link" }); present = true; } }
      for (const p of allPulls) {
        if (p.number === n && eventIsPr) continue;
        const viaPrior = prior.has(reqFromPr(p)) || prior.has(rootMarker(p)), viaCur = cur.has(reqFromPr(p)) || cur.has(rootMarker(p));
        if (!viaPrior && !viaCur) continue;
        // History of the current link proves a FORMER root only when no payload prior exists to say the link may have moved (issue events:
        // the issue number cannot move). With a payload prior, only the prior side may satisfy `present`.
        const counts = viaPrior || !eventIsPr || typeof prevBody !== "string";
        const pm = rootMarker(p);
        if (pm === "ambiguous") throw Object.assign(new Error("previous_root_ambiguous"), { detail: { source: what, pr: p.number } });
        if (Number.isInteger(pm)) { if (counts) present = true; const r = await rootOf(pm); if (r.error) { roots.add(pm); diagnostics.push({ source: what, formerRoot: pm, via: "history_marker_unverified", why: r.error }); } else { roots.add(r.root); diagnostics.push({ source: what, formerRoot: r.root, via: "history_marker", pr: p.number, counted: counts }); } }
      }
      if (!present) throw Object.assign(new Error("previous_root_unprovable"), { detail: { source: what } });
    };
    if (eventIsPr) {
      const evPr = await gh.getPull(n);
      const linked = reqFromPr(evPr);
      const linkedRoot = linked ? await addRoot(linked, `pr#${n}.linked`) : null;
      const m = rootMarker(evPr);
      if (m === "ambiguous") throw Object.assign(new Error("root_request_ambiguous"), { detail: { pr: n } });
      // Issue #186: an event PR whose linked-issue reference and/or trusted root marker is ABSENT/invalid (e.g. just edited away) cannot
      // be attributed from its current body, and the body may have been the sole evidence for its siblings. It is a LOST source, never
      // "direct PR only". No linked issue => the former root has no independent anchor => superset. Marker absent => recovered only from
      // other PRs linked to the same issue (below), else superset.
      if (!linked) lost.push({ source: `pr#${n}.linked`, issue: null, error: "pr_link_missing" });
      else if (m === null) lost.push({ source: `pr#${n}.marker`, issue: linked, error: "pr_marker_missing" });
      if (Number.isInteger(m)) {
        const mRoot = await addRoot(m, `pr#${n}.marker`);
        // a PR whose own marker disagrees with its linked lineage was retargeted/forged: the OLD root is unknowable => superset
        if (linkedRoot !== null && mRoot !== null && linkedRoot !== mRoot) throw Object.assign(new Error("root_marker_conflict"), { detail: { pr: n } });
      }
      // Issue #192: the former root is derived INDEPENDENTLY of `lost` (a combined link+marker edit is exactly when it is needed).
      // Without a payload prior the old link is unknowable once anything was lost => conservative superset, never B-only.
      if (canMove) {
        if (lost.length && typeof prevBody !== "string") throw Object.assign(new Error("root_marker_lost"), { detail: { source: `pr#${n}.prior`, why: "attribution_lost_without_prior_candidate" } });
        await former(linked ?? null, evPr.user, `pr#${n}.prior`);
        formerProven = true;
      }
    } else {
      await addRoot(n, `issue#${n}`);
      // An issue's number cannot change, so its anchors are exactly the PRs linked to it: with a lost marker and NO payload prior the
      // lost recovery below (history of PRs linked to this very issue; conflict/none => superset) stays the independent source.
      if (canMove && (!lost.length || typeof prevBody === "string")) {
        const ev = await gh.getIssue(n).catch(() => null);
        await former(n, ev?.user ?? { login: "jonghee1998", id: 129052128, type: "User" }, `issue#${n}.prior`);
        formerProven = true;
      }
    }
    // Issue #184: recover the FORMER root of every lost source from independently verified history = the PR(s) directly linked to that issue
    // carrying their OWN trusted marker that resolves (self-marked root). No recoverable, agreeing root => conservative superset.
    for (const l of lost) {
      // Movable event whose former root(s) are already proven independently: the lost marker needs no (current-side-only) recovery. The
      // current root, when known, came from the live link; a lost link (issue null) still falls to the superset below.
      if (formerProven && l.issue !== null) continue;
      // Issue #192 noise control: a NON-moving event (comment / issue opened) on an issue that no PR (any state) links to or names, and that
      // carries no marker, is anchored to no root. Moving events and any issue with an anchoring PR keep the conservative path.
      if (!canMove && !eventIsPr && l.issue === n && !allPulls.some((p) => reqFromPr(p) === n || rootMarker(p) === n)) { diagnostics.push({ source: l.source, unrelated: "anchorless_unmarked_issue" }); continue; }
      if (l.issue === null) throw Object.assign(new Error("root_marker_lost"), { detail: { source: l.source, why: "no_linked_issue_for_event_pr" } });
      const hist = new Set();
      for (const p of allPulls) {
        if (reqFromPr(p) !== l.issue || p.number === n) continue;
        const pm = rootMarker(p);
        if (pm === "ambiguous") throw Object.assign(new Error("root_marker_lost"), { detail: { source: l.source, why: "historical_marker_ambiguous", pr: p.number } });
        if (!Number.isInteger(pm)) continue;
        const pr = await rootOf(pm);
        if (pr.error) continue;
        hist.add(pr.root);
      }
      if (hist.size !== 1) throw Object.assign(new Error("root_marker_lost"), { detail: { source: l.source, why: hist.size ? "historical_roots_conflict" : "no_verified_historical_link" } });
      const [hr] = hist; roots.add(hr); diagnostics.push({ source: l.source, recoveredRoot: hr, via: "linked_pr_marker" });
    }
    for (const p of eligible) {
      if (p.number === n) continue;
      const l = reqFromPr(p);
      if (!l) continue; // no linked issue: cannot be attributed, and its own check already fails closed on req_unresolvable
      if (l === n && !eventIsPr) { direct.add(p.number); continue; }
      const r = await rootOf(l);
      // Unattributable lineage may be exactly the evidence that was just edited/deleted: REFRESH it (it fails closed in its own check)
      // instead of leaving a stale success behind.
      if (r.error) { diagnostics.push({ pr: p.number, unattributable: r.error }); direct.add(p.number); continue; }
      if (roots.has(r.root) || r.root === n) direct.add(p.number);
    }
    const targets = [...direct].sort((a, b) => a - b);
    return capped(targets.length ? { targets, roots: [...roots], diagnostics } : { targets: [], skip: roots.size ? "no_open_pr_for_root" : "unrelated_no_root_marker", roots: [...roots], diagnostics });
  } catch (e) {
    // Root/marker not provably resolved => conservative SUPERSET: every eligible open PR is re-evaluated (invalidated, then its own check
    // fails closed or re-proves). A failing plan job alone does NOT invalidate anything.
    return capped({ targets: superset(), error: String(e?.message ?? e).slice(0, 120), detail: e?.detail, diagnostics, superset: true });
  }
}

/**
 * ONE per-PR refresh: the ONLY path that publishes `quality-gate/*` statuses. Runs inside the per-PR lock so invalidate -> collect ->
 * final re-read -> publish for BOTH stages cannot interleave with any other writer of the same PR (events, PR workflow, dispatch, CLI).
 * The LIVE PR is read first: closed/fork/off-allowlist PRs are skipped without writing; the published SHA is the live head.
 */
export async function refreshPr({ gh, prNumber, allowlist, publish = true, check = runCheck, lock = defaultPrLock, payloadHead, out = () => {}, event }) {
  return lock.run(LOCK_GROUP(prNumber), async () => {
    let pr;
    try { pr = await gh.getPull(prNumber); } catch { pr = null; }
    if (pr && !ELIGIBLE(pr, allowlist)) { out({ event, pr: prNumber, result: "skip", reason: "pr_out_of_scope" }); return []; }
    const expectedHead = SHA.test(pr?.head?.sha ?? "") ? pr.head.sha : (SHA.test(payloadHead ?? "") ? payloadHead : undefined);
    const results = [];
    // Issue #192: invalidate BOTH contexts on the live head BEFORE any stage collects or evaluates evidence, so no stale success of either
    // context stays visible while the other stage is being evaluated. A head that moves meanwhile is invalidated too (bounded re-read).
    // A failed invalidation write is reported (`invalidation_failed`, published:false) and that stage is NOT evaluated; it is never
    // reported as invalidated. runCheck still invalidates again itself (idempotent), so the check command stays safe on its own.
    const failedInv = new Set();
    if (publish && expectedHead) {
      const done = new Set();
      let head = expectedHead;
      for (let i = 0; i < 3 && head && !done.has(head); i++) {
        done.add(head);
        for (const stage of STAGES) {
          try { await gh.createCommitStatus(head, { state: "pending", context: `quality-gate/${stage}`, description: "re-evaluating evidence" }); }
          catch { failedInv.add(stage); }
        }
        let again = null;
        try { again = await gh.getPull(prNumber); } catch { /* keep the last known head */ }
        head = SHA.test(again?.head?.sha ?? "") ? again.head.sha : null;
      }
    }
    for (const stage of STAGES) {
      if (failedInv.has(stage)) {
        const row = { pr: prNumber, stage, status: "blocked", head: expectedHead, published: false, unmet: ["invalidation_failed"] };
        results.push(row); out({ event, ...row }); continue;
      }
      const res = await check({ gh, prNumber, stage, publish, expectedHead });
      const row = { pr: prNumber, stage, status: res.status, head: res.head, published: res.published, unmet: res.unmet };
      results.push(row); out({ event, ...row });
    }
    return results;
  });
}

/** Wake -> root-aware targets (deduped) -> refresh each. Different PRs are independent (own lock key); the same PR is serialized. */
export async function handleEvent({ name, payload, gh, allowlist, publish = true, check = runCheck, lock = defaultPrLock, out = () => {} }) {
  const r = await targetsFromEvent({ name, payload, gh, allowlist });
  if (r.error) out({ event: name, result: r.blocked ? "BLOCKED" : "error", reason: r.error, detail: r.detail, stale: r.stale });
  if (!r.targets.length) { if (!r.error) out({ event: name, result: "skip", reason: r.skip }); return { results: [], skipped: r.skip, error: r.error, blocked: r.blocked, stale: r.stale }; }
  const all = await Promise.all(r.targets.map((prNumber) => refreshPr({ gh, prNumber, allowlist, publish, check, lock, out, event: name, payloadHead: payload?.pull_request?.number === prNumber ? payload.pull_request.head?.sha : undefined })));
  return { results: all.flat(), error: r.error, blocked: r.blocked, stale: r.stale, targets: r.targets };
}

// CLI modes (workflows): `--plan` prints/emits the root-aware target list (never writes statuses); `--pr N` refreshes ONE PR under the lock
// marker QUALITY_GATE_PR_LOCK=quality-gate-pr-N (set only by the per-PR concurrency job). Publishing without that marker is refused.
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const allowlist = (process.env.QUALITY_GATE_ALLOWLIST ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!process.env.GITHUB_TOKEN || !allowlist.length) { console.error("GITHUB_TOKEN and QUALITY_GATE_ALLOWLIST required"); process.exit(2); }
  const gh = createClient({ token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY });
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const name = process.env.GITHUB_EVENT_NAME;
  const out = (o) => console.log(JSON.stringify(o));
  if (process.argv.includes("--plan")) {
    const r = await targetsFromEvent({ name, payload, gh, allowlist });
    out({ event: name, ...r });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `targets=${JSON.stringify(r.targets)}\nerror=${r.error ?? ""}\nstale=${r.stale ?? ""}\n`);
    process.exit(0); // the workflow's next step fails the job when `error` is non-empty (targets still run so each PR publishes its own verdict)
  }
  const pr = Number(arg("pr"));
  if (!posInt(pr)) { console.error("usage: event-route.mjs --plan | --pr N"); process.exit(2); }
  if (process.env.QUALITY_GATE_PR_LOCK !== LOCK_GROUP(pr) && !process.argv.includes("--dry-run")) { console.error(`refusing to publish without lock marker ${LOCK_GROUP(pr)}`); process.exit(2); }
  const results = await refreshPr({ gh, prNumber: pr, allowlist, publish: !process.argv.includes("--dry-run"), out, event: name, payloadHead: payload?.pull_request?.head?.sha });
  process.exit(results.some((x) => x.published === false && !process.argv.includes("--dry-run")) ? 1 : 0);
}
