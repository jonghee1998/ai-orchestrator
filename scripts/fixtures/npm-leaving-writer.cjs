// Test double for `npm run typecheck` / `npm test` (#49). Logs the call, then leaves a background writer in its own
// process group (like a test that forks a watcher or a stray `git push &`). TEST_WRITES enables the writer;
// NPM_HOLD_MS keeps the "test run" alive for that long (so a lease revocation can land DURING tests).
const fs = require("fs"), { spawn } = require("child_process");
fs.appendFileSync(process.env.CALL_LOG, process.argv.slice(2).join(" ") + "\n");
const target = process.env.TEST_WRITES;
if (target) {
  const w = spawn(process.execPath, ["-e", `process.on("SIGTERM",()=>{});setInterval(()=>require("fs").appendFileSync(${JSON.stringify(target)},"t"),10)`], { stdio: "ignore" });
  fs.appendFileSync(target + ".pids", w.pid + "\n");
}
setTimeout(() => process.exit(0), Number(process.env.NPM_HOLD_MS || 50));
