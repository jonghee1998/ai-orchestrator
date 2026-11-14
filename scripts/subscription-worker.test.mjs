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
import { childEnvironment, verifyResponse } from "./subscription-worker.mjs";
const exec = promisify(execFile);
const hmac = (secret, text) => createHmac("sha256", secret).update(text).digest("hex");
test("runner checks signed response identity/freshness and strips model keys/control secrets from child environment", () => {
  const secret = "sec", at = new Date().toISOString(), eventId = "worker-01", raw = JSON.stringify({ at, eventId });
  assert.equal(verifyResponse(secret, eventId, raw, hmac(secret, `${at}.${eventId}.${raw}`)).eventId, eventId);
  assert.throws(() => verifyResponse(secret, "other", raw, hmac(secret, `${at}.${eventId}.${raw}`)));
  assert.throws(() => verifyResponse(secret, eventId, raw, "a".repeat(64)));
  assert.throws(() => verifyResponse(secret, eventId, JSON.stringify({ at: "2000-01-01", eventId }), ""));
  assert.deepEqual(childEnvironment({ PATH: "/bin", GH_TOKEN: "github", GATE_SECRET: "s", RUN_CALLBACK_SECRET_CODEX: "s", CONTROL_ADMIN_TOKEN: "s", DATABASE_URL: "s", OPENAI_API_KEY: "s", ANTHROPIC_API_KEY: "s" }), { PATH: "/bin", GH_TOKEN: "github" });
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
