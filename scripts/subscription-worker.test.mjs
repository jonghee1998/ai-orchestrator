import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { childEnvironment, verifyResponse, leaseController, superviseChild, groupAlive, createSupervisor, stopGroup, probeGroup, processTableIdentity, sameIdentity, replayCleanup } from "./subscription-worker.mjs";
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
const exec = promisify(execFile);
const hmac = (secret, text) => createHmac("sha256", secret).update(text).digest("hex");
test("runner checks signed response identity/freshness and strips model keys/control secrets from child environment", () => {
  const secret = "sec", at = new Date().toISOString(), eventId = "worker-01", raw = JSON.stringify({ at, eventId });
  assert.equal(verifyResponse(secret, eventId, raw, hmac(secret, `${at}.${eventId}.${raw}`)).eventId, eventId);
  assert.throws(() => verifyResponse(secret, "other", raw, hmac(secret, `${at}.${eventId}.${raw}`)));
  assert.throws(() => verifyResponse(secret, eventId, raw, "a".repeat(64)));
  assert.throws(() => verifyResponse(secret, eventId, JSON.stringify({ at: "2000-01-01", eventId }), ""));
  assert.deepEqual(childEnvironment({ PATH: "/bin", GH_TOKEN: "github", GATE_SECRET: "s", RUN_CALLBACK_SECRET_CODEX: "s", CONTROL_ADMIN_TOKEN: "s", DATABASE_URL: "s", OPENAI_API_KEY: "s", ANTHROPIC_API_KEY: "s", ROUTINE_FIRE_TOKEN: "routine-secret", ROUTINE_FIRE_URL: "https://api.anthropic.com/trig", VERCEL_AUTOMATION_BYPASS_SECRET: "bypass-secret", CLAUDE_CODE_OAUTH_TOKEN: "cli-oauth-token" }), { PATH: "/bin", GH_TOKEN: "github", CLAUDE_CODE_OAUTH_TOKEN: "cli-oauth-token" });
});
test("runner executes a claimed subscription CLI and real child test commands, persists result and replays completion without rerunning", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "worker-")), cwd = path.join(root, "repo"), bin = path.join(root, "bin");
  await fs.mkdir(cwd); await fs.mkdir(bin);
  await exec("git", ["init", "-b", "codex/review"], { cwd });
  await exec("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "fixture"], { cwd });
  await exec("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd });
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd }); const sha = stdout.trim();
  const log = path.join(root, "calls");
  // Test doubles for subscription CLI and npm only. No provider/model call occurs in this test.
  await fs.writeFile(path.join(bin, "codex"), `#!${process.execPath}\nconst fs=require('fs');fs.appendFileSync(process.env.CALL_LOG,'codex\\n');const a=process.argv;fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({summary:'Review completed',prNumber:35}));`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, "npm"), `#!${process.execPath}\nrequire('fs').appendFileSync(process.env.CALL_LOG,process.argv.slice(2).join(' ')+'\\n');`, { mode: 0o755 });
  const secret = "test-secret", finishes = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString(), b = JSON.parse(raw), id = req.headers["x-event-id"], ts = req.headers["x-timestamp"];
      assert.equal(req.headers["x-signature"], hmac(secret, `${ts}.${id}.${raw}`));
      let payload;
      if (req.url === "/api/gate") payload = { allow: true, agent: "codex", issueNumber: 36, dispatchId: "dispatch-1" };
      else if (b.action === "lease") payload = { lease: "held" };
      else if (b.action === "claim") payload = { record: { dispatchId: "dispatch-1", agent: "codex", issueNumber: 36, runId: b.runId,
        collaboration: { step: "codex", repo: "o/r", baseBranch: "claude/base", baseSha: sha, workBranch: "claude/fix", targetSha: sha, prNumber: 35, instructions: "Review" } } };
      else { finishes.push(b); payload = { workflow: { stage: "pm" } }; }
      const at = new Date().toISOString(), text = JSON.stringify({ ...payload, at, eventId: id });
      res.writeHead(200, { "content-type": "application/json", "x-signature": hmac(secret, `${at}.${id}.${text}`) }); res.end(text);
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log, ORCH_URL: `http://127.0.0.1:${server.address().port}`, GATE_SECRET: secret };
  const args = [path.resolve("scripts/subscription-worker.mjs"), "codex", "36", "dispatch-1", cwd];
  try {
    await exec(process.execPath, args, { env });
    assert.equal(finishes.length, 1);
    assert.equal(finishes[0].result.exitCode, 0);
    assert.deepEqual(finishes[0].result.tests, [{ command: "npm run typecheck", exitCode: 0 }, { command: "npm test", exitCode: 0 }]);
    const files = await fs.readdir(path.join(cwd, ".git/orchestrator"));
    const saved = path.join(cwd, ".git/orchestrator", files.find(f => !f.endsWith("-agent.json")));
    await exec(process.execPath, [...args, saved], { env });
    assert.equal(finishes.length, 2);
    assert.deepEqual(finishes[1].result, finishes[0].result);
    assert.equal(await fs.readFile(log, "utf8"), "codex\nrun typecheck\ntest\n");
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); }
});

// #41 P1: a still-running old worker must be physically stopped (whole process group) before quiescence is reported.
// A zombie (exited, awaiting a possibly slow init reaper) cannot run or write, so it does not count as alive.
const alive = pid => { try { process.kill(pid, 0); } catch { return false; }
  try { const st = require("node:fs").readFileSync(`/proc/${pid}/stat`, "utf8"); return !/^[ZX]$/.test(st.slice(st.lastIndexOf(")") + 2, st.lastIndexOf(")") + 3)); } catch { return true; } };
async function stubborn(renew, leaseOpts) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "fence-")), target = path.join(root, "branch-writes");
  const lease = leaseController(renew, leaseOpts);
  const started = Date.now();
  const r = await superviseChild(process.execPath, [path.resolve("scripts/fixtures/stubborn-writer.cjs"), target], root, process.env, lease, { graceMs: 100 });
  lease.stop();
  const pids = JSON.parse(await fs.readFile(target + ".pids", "utf8"));
  const sizeAtFence = (await fs.stat(target)).size;
  await new Promise(res => setTimeout(res, 300));
  const sizeLater = (await fs.stat(target)).size, content = await fs.readFile(target, "utf8");
  await fs.rm(root, { recursive: true, force: true });
  return { r, pids, sizeAtFence, sizeLater, content, elapsed: Date.now() - started };
}
test("P1: server lease revocation kills a still-writing CLI and its grandchild; no write happens after quiescence", async () => {
  let renewals = 0;
  const { r, pids, sizeAtFence, sizeLater, content } = await stubborn(async () => (++renewals >= 3 ? "revoked" : "held"), { intervalMs: 40 });
  assert.equal(r.fenced.reason, "lease_revoked");
  assert.equal(r.fenced.processGroupEmpty, true);
  assert.equal(r.fenced.signal, "SIGKILL"); // SIGTERM was ignored by both writers
  assert.ok(content.includes("c") && content.includes("g"), "both the CLI and its grandchild were writing before the fence");
  assert.equal(sizeLater, sizeAtFence, "old worker wrote after it was reported quiescent");
  assert.ok(pids.every(p => !alive(p)) && !groupAlive(pids[0]));
});
test("P1: an unreachable orchestrator self-fences before the server heartbeat timeout", async () => {
  const { r, pids, sizeAtFence, sizeLater } = await stubborn(async () => { throw new Error("network down"); }, { intervalMs: 30, selfFenceMs: 150 });
  assert.equal(r.fenced.reason, "lease_expired");
  assert.equal(sizeLater, sizeAtFence);
  assert.ok(pids.every(p => !alive(p)));
});
test("P1: a normally exiting CLI still has stragglers in its process group reaped before results are reported", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reap-")), target = path.join(root, "w");
  const lease = leaseController(async () => "held", { intervalMs: 1000 });
  // Leader exits immediately, leaving a background writer (e.g. a detached `git push &`) in its group.
  const r = await superviseChild(process.execPath, [path.resolve("scripts/fixtures/exit-leaving-writer.cjs"), target], root, process.env, lease, { graceMs: 100 });
  lease.stop();
  assert.equal(r.fenced, null); assert.equal(r.exitCode, 0); assert.equal(r.proof.processGroupsEmpty, true);
  const a = (await fs.stat(target)).size; await new Promise(res => setTimeout(res, 200));
  assert.equal((await fs.stat(target)).size, a);
  await fs.rm(root, { recursive: true, force: true });
});

// #49 (PR48 P1 x2): cleanup must be PROVEN for every process group (CLI and tests) before finish or quiesce.
const deny = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };
const killGroup = pid => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } };
const pause = ms => new Promise(res => setTimeout(res, ms));
const grows = async file => { const a = (await fs.stat(file)).size; await pause(150); return (await fs.stat(file)).size > a; };
test("#49 P1: denied cleanup with a surviving writer yields NO proof and no fence claim (stop is never invented)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deny-")), target = path.join(root, "branch-writes");
  let renewals = 0;
  const lease = leaseController(async () => (++renewals >= 3 ? "revoked" : "held"), { intervalMs: 40 });
  let pids = [];
  try {
    const r = await superviseChild(process.execPath, [path.resolve("scripts/fixtures/stubborn-writer.cjs"), target], root, process.env, lease, { graceMs: 50, confirmMs: 150, kill: deny });
    lease.stop();
    pids = JSON.parse(await fs.readFile(target + ".pids", "utf8"));
    assert.equal(lease.fenced, "lease_revoked");
    assert.equal(r.fenced, null, "a fence must not be reported when cleanup is unproven");
    assert.equal(r.proof, null);
    assert.equal(r.cleanupUnproven[0].state, "unproven");
    assert.ok(groupAlive(pids[0]) && await grows(target), "precondition: the writer really survived the denied signals");
  } finally { lease.stop(); if (pids[0]) killGroup(pids[0]); await fs.rm(root, { recursive: true, force: true }); }
});
test("#49 P1: revocation DURING tests stops the active test group (incl. its background writer); CLI group already exited", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tst-")), target = path.join(root, "test-writes");
  let revoke = false;
  const lease = leaseController(async () => (revoke ? "revoked" : "held"), { intervalMs: 30 });
  const sup = createSupervisor(lease, { graceMs: 50, confirmMs: 2000 });
  const env = { ...process.env, CALL_LOG: path.join(root, "calls"), TEST_WRITES: target, NPM_HOLD_MS: "60000" };
  try {
    const cli = await sup.run(process.execPath, ["-e", "process.exit(0)"], root, env, true);
    assert.equal(cli.exitCode, 0);
    const running = sup.run(process.execPath, [path.resolve("scripts/fixtures/npm-leaving-writer.cjs"), "test"], root, env);
    for (let i = 0; !(await fs.stat(target).catch(() => null)); i++) { assert.ok(i < 500, "test writer never started"); await pause(10); }
    assert.ok(await grows(target), "test descendant writes while tests run");
    revoke = true;
    await running; await sup.settle(); lease.stop();
    const proof = sup.proof();
    assert.equal(proof.processGroupsEmpty, true); assert.equal(proof.groups, 2);
    assert.equal((await sup.run(process.execPath, ["-e", ""], root, env)).refused, true, "no new group may start after a fence");
    const writer = Number((await fs.readFile(target + ".pids", "utf8")).trim());
    assert.ok(!alive(writer)); assert.ok(!(await grows(target)), "test descendant wrote after proven quiescence");
  } finally { lease.stop(); await fs.rm(root, { recursive: true, force: true }); }
});

// End-to-end runner harness: real runner process, real CLI/npm stand-in processes, signed fake orchestrator.
const WORKER = process.env.WORKER_UNDER_TEST ?? path.resolve("scripts/subscription-worker.mjs");
async function harness({ lease = () => "held", npmEnv = {}, runnerEnv = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-")), cwd = path.join(root, "repo"), bin = path.join(root, "bin");
  await fs.mkdir(cwd); await fs.mkdir(bin);
  await exec("git", ["init", "-b", "codex/review"], { cwd });
  await exec("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "--allow-empty", "-m", "fixture"], { cwd });
  await exec("git", ["remote", "add", "origin", "https://github.com/o/r.git"], { cwd });
  const sha = (await exec("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  const writes = path.join(root, "test-writes"), size = () => fs.stat(writes).then(s => s.size, () => 0);
  await fs.writeFile(path.join(bin, "codex"), `#!${process.execPath}\nconst a=process.argv;require('fs').writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({summary:'Review completed',prNumber:35}));`, { mode: 0o755 });
  await fs.writeFile(path.join(bin, "npm"), `#!${process.execPath}\nrequire(${JSON.stringify(path.resolve("scripts/fixtures/npm-leaving-writer.cjs"))});`, { mode: 0o755 });
  const secret = "test-secret", reports = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString(), b = JSON.parse(raw), id = req.headers["x-event-id"], ts = req.headers["x-timestamp"];
      assert.equal(req.headers["x-signature"], hmac(secret, `${ts}.${id}.${raw}`));
      let payload;
      if (req.url === "/api/gate") payload = { allow: true, agent: "codex", issueNumber: 36, dispatchId: "dispatch-1" };
      else if (b.action === "lease") payload = { lease: await lease(writes) };
      else if (b.action === "claim") payload = { record: { dispatchId: "dispatch-1", agent: "codex", issueNumber: 36, runId: b.runId,
        collaboration: { step: "codex", repo: "o/r", baseBranch: "claude/base", baseSha: sha, workBranch: "claude/fix", targetSha: sha, prNumber: 35, instructions: "Review" } } };
      else { reports.push({ ...b, writesAtReceipt: await size() }); payload = { workflow: { stage: "pm" } }; }
      const at = new Date().toISOString(), text = JSON.stringify({ ...payload, at, eventId: id });
      res.writeHead(200, { "content-type": "application/json", "x-signature": hmac(secret, `${at}.${id}.${text}`) }); res.end(text);
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: path.join(root, "calls"), TEST_WRITES: writes,
    ORCH_URL: `http://127.0.0.1:${server.address().port}`, GATE_SECRET: secret, ORCH_LEASE_INTERVAL_MS: "50", ORCH_FENCE_GRACE_MS: "100", ORCH_FENCE_CONFIRM_MS: "300", ...npmEnv, ...runnerEnv };
  const run = (...extra) => exec(process.execPath, [WORKER, "codex", "36", "dispatch-1", cwd, ...extra], { env, timeout: 60_000 }).then(() => 0, e => e.code ?? 1);
  // Same runner, started through a wrapper (e.g. into another pid namespace).
  const runVia = (wrapper, ...extra) => exec(wrapper[0], [...wrapper.slice(1), process.execPath, WORKER, "codex", "36", "dispatch-1", cwd, ...extra], { env, timeout: 60_000 }).then(() => 0, e => e.code ?? 1);
  const savedFile = async () => path.join(cwd, ".git/orchestrator", (await fs.readdir(path.join(cwd, ".git/orchestrator"))).find(f => !f.endsWith("-agent.json")));
  const writerPids = () => fs.readFile(writes + ".pids", "utf8").then(t => t.trim().split("\n").filter(Boolean).map(Number), () => []);
  const close = async () => { for (const p of await writerPids()) killGroup(p); for (const p of await writerPids()) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
    server.closeAllConnections(); await new Promise(r => server.close(r)); await fs.rm(root, { recursive: true, force: true }); };
  return { run, runVia, reports, writes, size, savedFile, writerPids, close };
}
test("#49 P1 e2e: normal successful exit leaving npm/test background writers -> reaped and proven BEFORE finish; finish carries cleanup proof", async () => {
  const h = await harness();
  try {
    assert.equal(await h.run(), 0);
    assert.deepEqual(h.reports.map(r => r.action), ["finish"]);
    const f = h.reports[0];
    assert.deepEqual(f.result.tests, [{ command: "npm run typecheck", exitCode: 0 }, { command: "npm test", exitCode: 0 }]);
    assert.deepEqual(f.result.cleanup, { processGroupsEmpty: true, groups: 3 }); // CLI + 2 test groups
    assert.equal((await h.writerPids()).length, 2);
    assert.ok((await h.writerPids()).every(p => !alive(p)), "test leftovers were reaped");
    await pause(150);
    assert.equal(await h.size(), f.writesAtReceipt, "a test descendant wrote after finish (proven completion)");
  } finally { await h.close(); }
});
test("#49 P1 e2e: lease revoked DURING tests -> active test group stopped and proven empty before quiesce; no later write", async () => {
  const h = await harness({ lease: async writes => (await fs.stat(writes).catch(() => null)) ? "revoked" : "held", npmEnv: { NPM_HOLD_MS: "60000" } });
  try {
    assert.equal(await h.run(), 3);
    assert.deepEqual(h.reports.map(r => r.action), ["quiesce"], "fenced: never finish");
    assert.equal(h.reports[0].quiescence.reason, "lease_revoked");
    assert.equal(h.reports[0].quiescence.signal, "SIGKILL"); // the test descendant ignores SIGTERM
    assert.ok((await h.writerPids()).every(p => !alive(p)));
    await pause(150);
    assert.equal(await h.size(), h.reports[0].writesAtReceipt, "a test descendant wrote after quiesce");
  } finally { await h.close(); }
});
test("#49 P1 e2e: denied cleanup of a surviving test writer withholds BOTH finish and quiesce; replay stays withheld until proven", async () => {
  const h = await harness({ runnerEnv: { ORCH_TEST_DENY_GROUP_SIGNALS: "1" } });
  try {
    assert.equal(await h.run(), 4);
    assert.deepEqual(h.reports.map(r => r.action), ["cleanup_failed"]);
    assert.deepEqual(h.reports[0].failure, { reason: "normal_exit", groups: 2, unproven: 1 }); // npm test never started
    const [writer] = await h.writerPids();
    assert.ok(alive(writer) && await grows(h.writes), "precondition: the writer survived");
    const saved = await h.savedFile(), file = JSON.parse(await fs.readFile(saved, "utf8"));
    assert.equal(file.result, undefined); assert.equal(file.quiescence, undefined); assert.equal(file.cleanupUnproven.failure.unproven, 1);
    // Replay while the writer is alive: still no finish/quiesce.
    assert.equal(await h.run(saved), 4);
    assert.deepEqual(h.reports.map(r => r.action), ["cleanup_failed", "cleanup_failed"]);
    // The owner stops it; replay probes the recorded groups and only then reports (probe-only) quiescence.
    process.kill(writer, "SIGKILL"); while (alive(writer)) await pause(10);
    assert.equal(await h.run(saved), 0);
    assert.deepEqual(h.reports.map(r => r.action), ["cleanup_failed", "cleanup_failed", "quiesce"]);
    assert.deepEqual(h.reports[2].quiescence, { reason: "cleanup_retry", processGroupEmpty: true, signal: null });
  } finally { await h.close(); }
});

// #51 (PR50 P1 r4575537380): unreadable /proc entries are insufficient visibility, never exit.
const realIo = { platform: process.platform, pid: process.pid, uid: () => process.getuid(), kill: (p, s) => process.kill(p, s), readdir: readdirSync,
  readFile: f => readFileSync(f, "utf8"), readlink: readlinkSync, stat: f => statSync(f) };
const errno = code => Object.assign(new Error(code), { code });
/** A real live writer in its own process group (leader + same-group grandchild, both ignoring SIGTERM). */
async function liveWriter() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "probe-")), target = path.join(root, "w");
  const child = spawn(process.execPath, [path.resolve("scripts/fixtures/stubborn-writer.cjs"), target], { detached: true, stdio: "ignore" });
  for (let i = 0; !(await fs.stat(target + ".pids").catch(() => null)) || !(await fs.stat(target).catch(() => null)); i++) { assert.ok(i < 500, "writer never started"); await pause(10); }
  const pids = JSON.parse(await fs.readFile(target + ".pids", "utf8"));
  return { pgid: child.pid, pids, target, done: async () => { killGroup(child.pid); for (const p of pids) while (alive(p)) await pause(10); await fs.rm(root, { recursive: true, force: true }); } };
}
const faultStat = (pids, code) => ({ ...realIo, readFile: f => { if (pids.some(p => f === `/proc/${p}/stat`)) throw errno(code); return realIo.readFile(f); } });
const linux = process.platform === "linux";
test("#51 P1: EACCES/EPERM on a LIVE writer's /proc stat keeps the group alive (old scan treated it as exited)", { skip: !linux && "Linux /proc only" }, async () => {
  const w = await liveWriter();
  try {
    for (const code of ["EACCES", "EPERM", "EIO"]) assert.deepEqual(probeGroup(w.pgid, faultStat(w.pids, code)), { alive: true, basis: "proc_unreadable" }, code);
    // Even an ENOENT lie for every member cannot fabricate emptiness: the kernel still reports the group present.
    assert.deepEqual(probeGroup(w.pgid, faultStat(w.pids, "ENOENT")), { alive: true, basis: "present_invisible" });
    const hide = { ...realIo, readFile: f => f === "/proc/self/mountinfo" ? "22 27 0:21 / /proc rw,relatime - proc proc rw,hidepid=2\n" : realIo.readFile(f) };
    assert.deepEqual(probeGroup(w.pgid, hide), { alive: true, basis: "proc_untrusted" });
    const foreign = { ...realIo, readlink: f => f === "/proc/self" ? "1" : realIo.readlink(f) };
    assert.deepEqual(probeGroup(w.pgid, foreign), { alive: true, basis: "proc_untrusted" });
    assert.ok(await grows(w.target), "precondition: the writer is really alive");
  } finally { await w.done(); }
});
test("#51 P1: supervisor with denied signals + unreadable live entries yields NO proof (fault-injected false processGroupEmpty)", { skip: !linux && "Linux /proc only" }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uproc-")), target = path.join(root, "w");
  let pids = [];
  const io = { ...realIo, readFile: f => { if (pids.some(p => f === `/proc/${p}/stat`)) throw errno("EACCES"); return realIo.readFile(f); } };
  const lease = leaseController(async () => "held", { intervalMs: 1000 });
  const sup = createSupervisor(lease, { graceMs: 50, confirmMs: 200, kill: deny, io });
  try {
    const running = sup.run(process.execPath, [path.resolve("scripts/fixtures/stubborn-writer.cjs"), target], root, process.env);
    for (let i = 0; !pids.length; i++) { assert.ok(i < 500); pids = JSON.parse(await fs.readFile(target + ".pids", "utf8").catch(() => "[]")); await pause(10); }
    await sup.settle(); // stop the (still running) leader's group: signals denied, entries unreadable
    lease.stop();
    assert.equal(sup.proof(), null, "unreadable live entries must never prove emptiness");
    assert.equal(sup.diagnostics()[0].state, "unproven");
    assert.ok(await grows(target), "precondition: the writer survived");
    killGroup(pids[0]); await running;
  } finally { lease.stop(); if (pids[0]) killGroup(pids[0]); await fs.rm(root, { recursive: true, force: true }); }
});
test("#51 P1: with real signals, unreadable entries do not block a genuine stop: SIGKILL + kernel ESRCH proves the group empty", { skip: !linux && "Linux /proc only" }, async () => {
  const w = await liveWriter();
  try {
    const r = await stopGroup(w.pgid, 50, 2000, undefined, faultStat(w.pids, "EACCES"));
    assert.deepEqual(r, { processGroupEmpty: true, signal: "SIGKILL" });
    assert.deepEqual(probeGroup(w.pgid), { alive: false, basis: "esrch" });
  } finally { await w.done(); }
});
test("#51 P1: confirmed exit race (ENOENT/ESRCH) is distinguished from insufficient visibility in a zombie-only group", () => {
  const stat = (pid, state, pgrp) => `${pid} (node) ${state} 1 ${pgrp} ${pgrp} 0 -1`;
  const io = (missing) => ({ platform: "linux", pid: 50, kill: () => {}, readlink: f => f === "/proc/self" ? "50" : "x",
    readdir: () => ["1", "self", "200", "201", "202"],
    readFile: f => { if (f === "/proc/self/mountinfo") return "22 27 0:21 / /proc rw - proc proc rw\n";
      if (f === "/proc/1/stat") return stat(1, "S", 1); if (f === "/proc/200/stat") return stat(200, "Z", 200);
      if (f === "/proc/202/stat") return stat(202, "S", 9); throw errno(missing); } });
  assert.deepEqual(probeGroup(200, io("ENOENT")), { alive: false, basis: "zombies_only" }, "member 201 exited meanwhile");
  assert.deepEqual(probeGroup(200, io("ESRCH")), { alive: false, basis: "zombies_only" });
  assert.deepEqual(probeGroup(200, io("EACCES")), { alive: true, basis: "proc_unreadable" }, "201 may be a live member we cannot see");
  assert.deepEqual(probeGroup(200, io("EPERM")), { alive: true, basis: "proc_unreadable" });
  const gone = { ...io("ENOENT"), kill: () => { throw errno("ESRCH"); } };
  assert.deepEqual(probeGroup(200, gone), { alive: false, basis: "esrch" });
  const denied = { ...io("ENOENT"), platform: "darwin", kill: () => { throw errno("EPERM"); } };
  assert.deepEqual(probeGroup(200, denied), { alive: true, basis: "signal0_present" }, "non-Linux: EPERM means present");
  assert.equal(probeGroup(1).alive, true); assert.equal(probeGroup(0).alive, true); // never probe/accept pgid 0/1
});

// #51 (PR50 P1 r4575537382): replay is valid only in the exact process table where the groups were recorded.
test("#51 P1: process-table identity is read live from the kernel; foreign /proc or non-Linux is unverifiable", { skip: !linux && "Linux /proc only" }, () => {
  const id = processTableIdentity();
  assert.ok(id && /^pid:\[\d+\]$/.test(id.pidNs) && /^[0-9a-f-]{36}$/.test(id.bootId) && /^\d+:\d+$/.test(id.nsDevIno));
  assert.ok(sameIdentity(id, processTableIdentity()));
  assert.equal(processTableIdentity({ ...realIo, readlink: f => f === "/proc/self" ? "1" : realIo.readlink(f) }), null);
  assert.equal(processTableIdentity({ ...realIo, platform: "darwin" }), null);
  assert.equal(processTableIdentity({ ...realIo, readFile: f => { if (f.endsWith("boot_id")) throw errno("EACCES"); return realIo.readFile(f); } }), null);
  for (const k of ["bootId", "pidNs", "nsDevIno"]) assert.equal(sameIdentity(id, { ...id, [k]: id[k] + "0" }), false, k);
  assert.equal(sameIdentity(id, null), false);
});
test("#51 P1: replay with absent/unavailable/different identity blocks even when the pgid is absent here; never signals", () => {
  const id = { v: 1, kernel: "linux", bootId: "3314f6cc-4a14-4906-9d74-37fedec7978f", pidNs: "pid:[4026531836]", nsDevIno: "4:4026531836" };
  const groups = [{ pgid: 4242, state: "unproven" }], gone = () => false, failure = { reason: "normal_exit", groups: 1, unproven: 1 };
  assert.deepEqual(replayCleanup({ failure, groups }, { identity: id, probe: gone }), { ok: false, reason: "identity_absent" }, "legacy diagnostic");
  assert.deepEqual(replayCleanup({ failure, groups, identity: null }, { identity: id, probe: gone }), { ok: false, reason: "identity_absent" });
  assert.deepEqual(replayCleanup({ failure, groups, identity: id }, { identity: null, probe: gone }), { ok: false, reason: "identity_unavailable" });
  for (const k of ["bootId", "pidNs", "nsDevIno"]) // other host / reboot / container or pid namespace
    assert.deepEqual(replayCleanup({ failure, groups, identity: { ...id, [k]: "other" } }, { identity: id, probe: gone }), { ok: false, reason: "identity_mismatch" }, k);
  assert.deepEqual(replayCleanup({ failure, groups: [], identity: id }, { identity: id, probe: gone }), { ok: false, reason: "malformed_groups" });
  assert.deepEqual(replayCleanup({ failure, groups: [{ pgid: 1, state: "unproven" }], identity: id }, { identity: id, probe: gone }), { ok: false, reason: "malformed_groups" });
  assert.deepEqual(replayCleanup({ failure, groups, identity: id }, { identity: id, probe: () => true }), { ok: false, reason: "alive", alive: 1 });
  assert.deepEqual(replayCleanup({ failure, groups, identity: id }, { identity: id, probe: gone }), { ok: true });
});
test("#51 P1: probe-only replay never signals a recycled pgid now owned by an unrelated live group", { skip: !linux && "Linux /proc only" }, async () => {
  const w = await liveWriter(); // stands in for an unrelated group that recycled the recorded pgid
  try {
    const sigs = [], spy = { ...realIo, kill: (p, s) => { sigs.push(s); return realIo.kill(p, s); } };
    const r = replayCleanup({ failure: { reason: "normal_exit", groups: 1, unproven: 1 }, groups: [{ pgid: w.pgid, state: "unproven" }], identity: processTableIdentity() },
      { probe: pg => groupAlive(pg, spy) });
    assert.deepEqual(r, { ok: false, reason: "alive", alive: 1 }, "fail closed: cannot tell the recycled group from the original");
    assert.ok(sigs.length && sigs.every(s => s === 0), `only signal 0 probes, got ${sigs}`);
    assert.ok(w.pids.every(alive) && await grows(w.target), "the unrelated group was not touched");
  } finally { await w.done(); }
});
test("#51 P1 e2e: diagnostic carries the verified identity; a wrong-environment replay can NEVER emit cleanup_retry (writer alive or not)", { skip: !linux && "Linux /proc only" }, async () => {
  const h = await harness({ runnerEnv: { ORCH_TEST_DENY_GROUP_SIGNALS: "1" } });
  try {
    assert.equal(await h.run(), 4);
    const [writer] = await h.writerPids(), saved = await h.savedFile(), file = JSON.parse(await fs.readFile(saved, "utf8"));
    assert.ok(sameIdentity(file.cleanupUnproven.identity, processTableIdentity()), "identity of the original process table is persisted");
    const variant = async (mutate) => { const f = structuredClone(file); mutate(f.cleanupUnproven); const p = saved + ".variant"; await fs.writeFile(p, JSON.stringify(f)); return p; };
    const otherHost = await variant(c => { c.identity.bootId = "00000000-0000-4000-8000-000000000000"; });
    const otherNs = await variant(c => { c.identity.pidNs = "pid:[1]"; c.identity.nsDevIno = "0:1"; });
    const legacy = await variant(c => { delete c.identity; }), unverifiable = await variant(c => { c.identity = null; });
    for (const p of [otherHost, otherNs, legacy, unverifiable]) assert.equal(await h.run(p), 5);
    assert.ok(alive(writer) && await grows(h.writes), "the original writer is still alive and was not signalled by any replay");
    assert.equal(await h.run(saved), 4, "original environment, writer alive: still withheld");
    // The writer is gone here, but a mismatched/absent identity is not stop evidence.
    process.kill(writer, "SIGKILL"); while (alive(writer)) await pause(10);
    for (const p of [otherHost, otherNs, legacy, unverifiable]) assert.equal(await h.run(p), 5);
    assert.ok(h.reports.every(r => r.action === "cleanup_failed"), "no quiesce/finish from an unverified environment");
    assert.equal(await h.run(saved), 0, "only the matching process table can prove the stop");
    assert.deepEqual(h.reports.at(-1), { ...h.reports.at(-1), action: "quiesce", quiescence: { reason: "cleanup_retry", processGroupEmpty: true, signal: null } });
    assert.equal(h.reports.filter(r => r.action === "quiesce").length, 1);
  } finally { await h.close(); }
});
const unshareOk = (() => { if (!linux) return false; try { execFileSync("unshare", ["--pid", "--fork", "--mount-proc", "true"], { stdio: "ignore" }); return true; } catch { return false; } })();
test("#51 P1 e2e: replay inside a REAL different pid namespace (writer invisible there) is blocked while the original writer survives",
  { skip: !unshareOk && "needs unshare --pid --mount-proc (root or user namespaces); covered by the identity-variant test" }, async () => {
  const h = await harness({ runnerEnv: { ORCH_TEST_DENY_GROUP_SIGNALS: "1" } });
  try {
    assert.equal(await h.run(), 4);
    const [writer] = await h.writerPids(), saved = await h.savedFile();
    // In the new namespace kill(-pgid,0) is ESRCH and /proc lacks the writer: the old runner reported cleanup_retry here.
    assert.equal(await h.runVia(["unshare", "--pid", "--fork", "--mount-proc"], saved), 5);
    assert.deepEqual(h.reports.map(r => r.action), ["cleanup_failed", "cleanup_failed"]);
    assert.ok(alive(writer) && await grows(h.writes), "the original writer is still alive");
  } finally { await h.close(); }
});
