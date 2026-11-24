// claude-work: merge the Codex root-cause analysis into the developer prompt.
//   node diag.mjs → reads $RUNNER_TEMP/work-prompt.md (+ codex-diag.md), writes `prompt` to $GITHUB_OUTPUT and the file back.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { withDiagnosis } from "./core.mjs";

const dir = process.env.RUNNER_TEMP ?? ".";
const read = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
const prompt = withDiagnosis(read("work-prompt.md"), read("codex-diag.md"));
fs.writeFileSync(path.join(dir, "work-prompt.md"), prompt);
if (process.env.GITHUB_OUTPUT) {
  const delim = `DG_${crypto.randomBytes(6).toString("hex")}`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `prompt<<${delim}\n${prompt}\n${delim}\n`);
}
console.log(`[diag] prompt ${prompt.length} chars${read("codex-diag.md") ? " (+ Codex diagnosis)" : ""}`);
