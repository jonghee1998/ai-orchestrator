// Claude usage-limit detection for claude-work (and any claude-code-action transcript).
//   node scripts/orch/limit.mjs <claude-execution-output.json>  -> writes `until=<ISO>` to $GITHUB_OUTPUT when limited
//
// A run that hit the subscription limit should wait until the limit resets instead of being blocked.
// Sources, newest wins:
//   1. rate_limit_event whose status is not "allowed"/"allowed_warning": the latest resetsAt among the
//      windows that are not allowed (fallback: rate_limit_info.resetsAt).
//   2. an error result whose text says "usage limit ... |<epoch seconds>" (older CLI format).
// Nothing found -> null (the caller blocks as before).

import fs from "node:fs";
import { pathToFileURL } from "node:url";

const OK_STATUS = new Set(["allowed", "allowed_warning"]);
const MAX_WAIT_MS = 8 * 24 * 3600 * 1000;   // longest window is 7 days; anything later is nonsense

/** Parse a transcript (JSON array or JSON lines) into events. Bad lines are skipped. */
export function events(text) {
  const s = String(text ?? "").trim();
  if (!s) return [];
  if (s.startsWith("[")) {
    try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { /* fall through to lines */ }
  }
  const out = [];
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { out.push(JSON.parse(t)); } catch { /* ignore */ }
  }
  return out;
}

const secToMs = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v * 1000 : null);

/** When the limit lifts, as ISO, or null if the transcript shows no usage limit. */
export function limitUntil(text, nowMs = Date.now()) {
  let until = null;
  for (const e of events(text)) {
    if (e?.type === "rate_limit_event" && e.rate_limit_info) {
      const info = e.rate_limit_info;
      const status = String(info.status ?? "");
      if (!status || OK_STATUS.has(status)) { until = null; continue; }   // a later "allowed" clears an earlier limit
      const wins = Object.values(info.unifiedWindows ?? {}).filter((w) => w && !OK_STATUS.has(String(w.status ?? "")));
      const ms = wins.map((w) => secToMs(w.resetsAt)).filter(Boolean);
      const t = ms.length ? Math.max(...ms) : secToMs(info.resetsAt);
      if (t) until = t;
    } else if (e?.type === "result" && e.is_error) {
      const msg = typeof e.result === "string" ? e.result : "";
      const m = /usage limit[^|]*\|(\d{9,11})/i.exec(msg);
      if (m) until = Number(m[1]) * 1000;
    }
  }
  if (!until || until <= nowMs || until - nowMs > MAX_WAIT_MS) return null;
  return new Date(until).toISOString();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let text = "";
  try { text = fs.readFileSync(process.argv[2], "utf8"); } catch { /* no transcript */ }
  const until = limitUntil(text);
  console.log(`[limit] ${until ? `usage limit until ${until}` : "no usage limit"}`);
  if (until && process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `until=${until}\n`);
}
