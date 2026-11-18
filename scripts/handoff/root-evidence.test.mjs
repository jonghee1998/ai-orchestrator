// Issue #172 — root-wide correction evidence through the REAL runLifecycle entrypoint with a complete mocked GitHub read facade.
import test from "node:test";
import assert from "node:assert/strict";
import { runLifecycle } from "./lifecycle-run.mjs";
import { parseConfig } from "./lifecycle.mjs";
import { correctionMarker, resolveCorrectionLimit } from "./root-corrections.mjs";
import { CODEX_BOT } from "./core.mjs";

const H = (c) => c.repeat(40);
const T = "codex/issue-92-mobile-v2", BASE = H("c"), TIP = H("e");
const CFG = parseConfig({ allowlist: [T], expectedBase: BASE });
const OWNER = { login: "jonghee1998", id: 129052128, type: "User" };
const MAL = { login: "mallory", id: 6, type: "User" };
const BOT = { login: CODEX_BOT.login, id: CODEX_BOT.id, type: "Bot" };
const S = { 153: H("1"), 160: H("2"), 165: H("3"), 167: H("4"), 169: H("5"), 171: H("6"), 173: H("7") };
const codex = (sha, unresolved) => `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, has_unresolved_findings: unresolved, status: "completed" }, security_review: { commit_sha: sha, status: "completed", has_unresolved_findings: false } })} -->`;
const marker = (n, pr, sha = S[pr], user = OWNER, id = 1000 + n) => ({ id, user, created_at: `2026-11-1${n}T00:00:00Z`, body: correctionMarker({ root: 146, n, pr, sha }) });
const limit = (max, id, at, user = OWNER) => ({ id, user, created_at: at, body: `<!-- orch-root-correction-limit:v1 root146 max=${max} -->` });
const mkPr = (number, sup, extra = {}) => ({ number, state: "open", merged: false, user: OWNER, created_at: "2026-11-18T00:00:00Z",
  body: `<!-- orch-root-request:v1 #146 -->\n<!-- orch-supersedes:v1 ${sup} -->\nRefs #${number === 173 ? 172 : 170}`, head: { ref: `b${number}`, sha: S[number] }, base: { ref: T, sha: BASE }, ...extra });
const rootIss = (n) => ({ number: n, user: OWNER, created_at: "2026-11-01T00:00:00Z", body: `<!-- orch-root-request:v1 #146 -->` });

/** Complete world; every source can be overridden. */
function world(o = {}) {
  const w = {
    pulls: { 173: mkPr(173, "pr171"), 171: mkPr(171, "pr169", { state: "closed" }), 169: mkPr(169, "none", { state: "closed" }) },
    issues: { 146: rootIss(146), 170: rootIss(170), 172: { ...rootIss(172), body: `<!-- orch-root-request:v1 #146 -->\n<!-- gpt-pm-followup:pr171:${S[171]}:claude:revise:7 -->` } },
    comments: {
      146: [marker(1, 153), marker(2, 160), marker(3, 165), limit(5, 2000, "2026-11-12T00:00:00Z"), marker(4, 167), marker(5, 169), limit(7, 2001, "2026-11-17T00:00:00Z")],
      171: [{ id: 5000, user: BOT, body: codex(S[171], true) }],
      173: [{ id: 5001, user: BOT, body: codex(S[173], false) }],
    },
    compare: () => "ahead", fail: {}, ...o,
  };
  return w;
}
const ghOf = (w, calls = []) => {
  const ok = (name, v) => { calls.push(name); if (w.fail[name]) throw new Error(`${name} failed`); return v; };
  return {
    getPull: async (n) => ok("getPull", w.pulls[n]),
    getIssue: async (n) => ok("getIssue", w.issues[n]),
    listIssues: async () => ok("listIssues", w.issueList ?? Object.values(w.issues)),
    listPulls: async () => ok("listPulls", w.pullList ?? Object.values(w.pulls)),
    listIssueComments: async (n) => ok("listIssueComments", w.comments[n] ?? []),
    getBranch: async () => ({ commit: { sha: TIP } }),
    compare: async (a, b) => ({ status: w.compare(a, b) }),
    listCheckRuns: async () => ({ total_count: 0, check_runs: [] }),
    getCommit: async () => ({}), getCombinedStatus: async () => ({}),
  };
};
const run = (w, pr = 173) => runLifecycle(ghOf(w), pr, { config: CFG, expectedHead: S[pr] });
const reason = (p) => p.reason ?? p.why;

test("correction 7 is permitted ONCE for root146 (max5 + later max7 coexist; n6 derived from PR171 @ exact SHA)", async () => {
  const p = await run(world());
  assert.equal(p.action === "blocked", false, JSON.stringify(p));
  assert.equal(p.key, "orch:v1:req146:pr173:accept:r7");
  assert.equal(p.mode, "dry-run"); assert.equal(p.live, false); assert.ok(p.writes.every((x) => x.type.endsWith("_planned")), "planned only, nothing executed");
});
test("an eighth correction is blocked (replacement of the 7th PR)", async () => {
  const w = world();
  w.pulls[175] = mkPr(175, "pr173"); w.pulls[173] = mkPr(173, "pr171", { state: "closed" }); w.pulls[175].head.sha = H("8"); w.pulls[175].body = w.pulls[175].body.replace(/Refs #\d+/, "Refs #172");
  w.comments[173] = [{ id: 5001, user: BOT, body: codex(S[173], true) }];
  w.comments[175] = [{ id: 5002, user: BOT, body: codex(H("8"), false) }];
  w.comments[146] = [...w.comments[146], marker(6, 171), marker(7, 173)];
  w.issues[172] = { ...w.issues[172], body: `<!-- orch-root-request:v1 #146 -->` };
  const p = await runLifecycle(ghOf(w), 175, { config: CFG, expectedHead: H("8") });
  assert.equal(p.action, "blocked");
  assert.ok(["round_cap_exceeded", "round_cap_reached_before_revision"].includes(p.reason), JSON.stringify(p));
});
test("limit policy history: only ordered, non-decreasing approvals; lowering never lowers consumption", async () => {
  const L = (m, id, at, u) => limit(m, id, at, u);
  assert.equal(resolveCorrectionLimit([L(5, 1, "2026-11-12T00:00:00Z"), L(7, 2, "2026-11-17T00:00:00Z")], 146).max, 7);
  assert.equal(resolveCorrectionLimit([L(5, 1, "2026-11-12T00:00:00Z"), L(7, 2, "2026-11-17T00:00:00Z")], 146).history.length, 2, "prior approval preserved");
  assert.equal(resolveCorrectionLimit([L(7, 2, "2026-11-12T00:00:00Z"), L(5, 1, "2026-11-17T00:00:00Z")], 146).error, "correction_limit_non_monotonic");
  assert.equal(resolveCorrectionLimit([L(5, 1), L(7, 2)].map((x) => ({ ...x, created_at: undefined })), 146).error, "correction_limit_conflict", "unorderable");
  assert.equal(resolveCorrectionLimit([L(5, 1, "2026-11-12T00:00:00Z"), L(7, 2, "2026-11-12T00:00:00Z")], 146).error, "correction_limit_conflict", "same timestamp");
  assert.equal(resolveCorrectionLimit([L(7, 1, "2026-11-12T00:00:00Z", MAL)], 146).max, 3, "untrusted approval ignored");
  // limit lowered later (5 after 7) => blocked, consumption stays (n1..n5 not erased)
  const w = world(); w.comments[146] = [...w.comments[146], limit(5, 2002, "2026-11-18T00:00:00Z")];
  assert.equal((await run(w)).reason, "correction_limit_non_monotonic");
});
test("unrelated roots keep default 3 / ceiling 5; 8th / 7th elsewhere never allowed", () => {
  const l = (r, m) => ({ user: OWNER, body: `<!-- orch-root-correction-limit:v1 root${r} max=${m} -->` });
  assert.equal(resolveCorrectionLimit([], 99).max, 3);
  assert.equal(resolveCorrectionLimit([l(99, 5)], 99).max, 5);
  assert.equal(resolveCorrectionLimit([l(99, 6)], 99).error, "correction_limit_out_of_range");
  assert.equal(resolveCorrectionLimit([l(146, 8)], 146).error, "correction_limit_out_of_range");
});
test("n6 is NOT invented: every missing proof blocks with a diagnostic", async () => {
  const cases = {
    "no codex receipt on PR171 exact SHA": (w) => { w.comments[171] = [{ id: 5000, user: BOT, body: codex(H("9"), true) }]; },
    "untrusted codex author": (w) => { w.comments[171] = [{ id: 5000, user: MAL, body: codex(S[171], true) }]; },
    "ancestry break (diverged)": (w) => { w.compare = () => "diverged"; },
    "ancestry unknown": (w) => { w.compare = () => "weird"; },
  };
  for (const [name, mut] of Object.entries(cases)) {
    const w = world(); mut(w);
    const p = await run(w);
    assert.equal(p.action, "blocked", name);
    assert.ok(/underivable|ancestry|supersede/.test(p.reason), `${name}: ${p.reason}`);
  }
});
test("request marker revise:N must equal the next ordinal (replay / wrong N blocks)", async () => {
  const w = world();
  w.issues[172] = { ...w.issues[172], body: `<!-- orch-root-request:v1 #146 -->\n<!-- gpt-pm-followup:pr171:${S[171]}:claude:revise:8 -->` };
  assert.equal((await run(w)).reason, "root_correction_legacy_out_of_range", "8th request exceeds the exact exception");
  const w2 = world();
  w2.issues[172] = { ...w2.issues[172], body: `<!-- orch-root-request:v1 #146 -->\n<!-- gpt-pm-followup:pr171:${S[171]}:claude:revise:6 -->` };
  assert.equal((await run(w2)).reason, "root_correction_request_mismatch");
});
test("sources × cases (root-wide; Issue body vs comment kinds; separate chains; untrusted/malformed/conflicting)", async () => {
  // separate chain: n1/n2 recorded ONLY in revision issue #150/#157 bodies & comments (not in root comments, not in current chain)
  const sep = world();
  sep.comments[146] = [marker(3, 165), marker(4, 167), marker(5, 169), limit(7, 2001, "2026-11-17T00:00:00Z")];
  sep.issues[150] = { ...rootIss(150), body: `<!-- orch-root-request:v1 #146 -->\n${correctionMarker({ root: 146, n: 1, pr: 153, sha: S[153] })}` };
  sep.comments[157] = [marker(2, 160)];
  sep.issues[157] = rootIss(157);
  const p = await run(sep);
  assert.equal(p.key, "orch:v1:req146:pr173:accept:r7", "n1/n2 found in separate-chain issue body + comment; no gap");
  // same without the separate-chain evidence => gap (proves those sources are actually consumed)
  const gap = world(); gap.comments[146] = [marker(3, 165), marker(4, 167), marker(5, 169), limit(7, 2001, "2026-11-17T00:00:00Z")];
  assert.equal((await run(gap)).reason, "root_correction_gap");
  // historical PR BODY (kind:pr) carrying a record
  const prBody = world(); prBody.comments[146] = prBody.comments[146].filter((c) => c.id !== 1001);
  prBody.pulls[153] = { ...mkPr(153, "none"), body: `<!-- orch-root-request:v1 #146 -->\n<!-- orch-supersedes:v1 none -->\n${correctionMarker({ root: 146, n: 1, pr: 153, sha: S[153] })}` };
  assert.notEqual((await run(prBody)).reason, "root_correction_gap");
  // duplicate identical evidence in two sources dedupes (no conflict)
  const dup = world(); dup.issues[150] = { ...rootIss(150), body: correctionMarker({ root: 146, n: 1, pr: 153, sha: S[153] }) + "\n<!-- orch-root-request:v1 #146 -->" };
  assert.equal((await run(dup)).key, "orch:v1:req146:pr173:accept:r7");
  // conflicting n/PR/SHA across sources
  const conf = world(); conf.issues[150] = { ...rootIss(150), body: `<!-- orch-root-request:v1 #146 -->\n${correctionMarker({ root: 146, n: 1, pr: 153, sha: H("f") })}` };
  assert.equal((await run(conf)).reason, "root_correction_conflict");
  // malformed marker
  const mal = world(); mal.issues[150] = { ...rootIss(150), body: `<!-- orch-root-request:v1 #146 -->\n<!-- orch-root-correction:v1 root146 n=x -->` };
  assert.equal((await run(mal)).reason, "root_correction_marker_malformed");
  // untrusted spoofed marker ignored: cannot raise OR lower; trusted count intact
  const spoof = world(); spoof.comments[146] = [...spoof.comments[146], marker(6, 999, H("a"), MAL, 7777)];
  assert.equal((await run(spoof)).key, "orch:v1:req146:pr173:accept:r7");
  // ... and an untrusted-only n6 can not stand in for the derivation / cannot lower: removing PR171 proof still blocks
  const spoof2 = world(); spoof2.comments[171] = []; spoof2.comments[146] = [...spoof2.comments[146], marker(6, 171, S[171], MAL, 7778)];
  assert.equal((await run(spoof2)).reason, "root_correction_underivable");
  // untrusted root marker on a stray issue/PR is not this root's evidence
  const stray = world(); stray.issues[300] = { ...rootIss(300), user: MAL, body: `<!-- orch-root-request:v1 #146 -->\n${correctionMarker({ root: 146, n: 9, pr: 1, sha: H("a") })}` };
  assert.equal((await run(stray)).key, "orch:v1:req146:pr173:accept:r7");
  // ambiguous root markers on a trusted issue
  const amb = world(); amb.issues[301] = { ...rootIss(301), body: "<!-- orch-root-request:v1 #146 -->\n<!-- orch-root-request:v1 #147 -->" };
  assert.equal((await run(amb)).reason, "root_request_ambiguous");
});
test("broken middle chain link, missing/ambiguous markers, first PR without correction, old PR replay", async () => {
  const mid = world(); mid.pulls[171] = { ...mkPr(171, "pr169"), body: "Refs #170" }; // trusted author but no supersedes marker
  assert.equal((await run(mid)).reason, "supersedes_marker_missing");
  const gone = world(); delete gone.pulls[169];
  assert.equal((await run(gone)).reason, "superseded_unavailable", "middle PR unreadable fails closed");
  const cyc = world(); cyc.pulls[169] = mkPr(169, "pr173");
  assert.equal((await run(cyc)).reason, "supersedes_cycle");
  // first PR with no correction: original PR, supersedes none, no markers anywhere => round 1
  const first = { pulls: { 9: { ...mkPr(9, "none"), head: { ref: "x", sha: H("a") }, body: "<!-- orch-root-request:v1 #146 -->\n<!-- orch-supersedes:v1 none -->\nRefs #170" } }, issues: { 146: rootIss(146), 170: rootIss(170) }, comments: { 9: [{ id: 1, user: BOT, body: codex(H("a"), false) }] }, compare: () => "ahead", fail: {} };
  const p1 = await runLifecycle(ghOf(first), 9, { config: CFG, expectedHead: H("a") });
  assert.equal(p1.key, "orch:v1:req146:pr9:accept:r1");
  // old PR replay: PR169 (own n5 marker) re-evaluated after n6 consumed => ordinal never below root count
  const old = world(); old.comments[169] = [{ id: 6001, user: BOT, body: codex(S[169], true) }];
  const po = await run(old, 169);
  assert.ok(po.action === "blocked" || po.action === "noop" || /r[5-9]/.test(po.key ?? ""), JSON.stringify(po));
  assert.ok(!/:r1$/.test(po.key ?? ""), "replay cannot reset to round 1");
});
test("partial pagination / API failure / non-array enumeration fail closed with a diagnostic", async () => {
  for (const name of ["listIssues", "listPulls", "listIssueComments", "getIssue", "getPull"]) {
    const w = world(); w.fail[name] = true;
    const p = await run(w);
    assert.equal(p.action, "blocked", name);
    assert.equal(p.reason, "evidence_load_failed", name);
  }
  const w = world(); w.issueList = { not: "an array" };
  assert.equal((await run(w)).reason, "evidence_load_failed");
});
test("real HTTP client: enumeration paths are GET-only and bounded (bound exceeded => throws)", async () => {
  const { createClient } = await import("./github.mjs");
  const calls = [];
  const page = (n) => Array.from({ length: 100 }, (_, i) => ({ number: n * 100 + i, user: OWNER, body: "" }));
  const gh = createClient({ token: "t", repo: "o/r", sleep: async () => {}, fetchImpl: async (url, init) => { calls.push(init.method + " " + new URL(url).pathname); return { ok: true, status: 200, json: async () => page(1) }; } });
  await assert.rejects(() => gh.listIssues(), /pagination bound exceeded/);
  await assert.rejects(() => gh.listPulls(), /pagination bound exceeded/);
  assert.ok(calls.every((c) => c.startsWith("GET ")));
});
