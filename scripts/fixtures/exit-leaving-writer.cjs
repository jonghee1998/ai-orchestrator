// Test double: the CLI exits 0 immediately but leaves a background writer (like `git push &`) in its group.
const { spawn } = require("child_process");
const target = process.argv[2];
spawn(process.execPath, ["-e", `setInterval(()=>require("fs").appendFileSync(${JSON.stringify(target)},"x"),10)`], { stdio: "ignore" });
setTimeout(() => process.exit(0), 100);
