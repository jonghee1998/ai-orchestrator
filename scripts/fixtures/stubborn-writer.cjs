// Test double for a CLI that keeps "pushing" after it should stop: it ignores SIGTERM, spawns a grandchild in
// the same process group that also writes, and appends to the target file every 10 ms. No network, no git.
const fs = require("fs"), { spawn } = require("child_process");
const target = process.argv[2];
process.on("SIGTERM", () => {});
const g = spawn(process.execPath, ["-e", `process.on("SIGTERM",()=>{});setInterval(()=>require("fs").appendFileSync(${JSON.stringify(target)},"g"),10)`], { stdio: "ignore" });
fs.writeFileSync(target + ".pids", JSON.stringify([process.pid, g.pid]));
setInterval(() => fs.appendFileSync(target, "c"), 10);
