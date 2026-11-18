// Issue #178 — ROOT-WIDE, fail-closed review-failure history for the quality gate. Read-only.
// Evidence = trusted-PM markers `<!-- gate:fail-class:v1 root=<R> class=<slug> pr=<P> sha=<40hex> -->` found anywhere in the root's evidence
// (root issue, every root-marked issue/PR, their comments, the PR under evaluation). One distinct (class, pr, sha) counts once, so duplicated /
// replayed / stale copies never inflate the count. Absent history is NOT the same as "no failures": an unreadable, partial, malformed or
// other-root source THROWS (or returns an error), and the caller must BLOCK. Only an authoritative empty read yields `[]`.
import { isTrustedPm } from "../handoff/core.mjs";

const ANY = /<!--\s*gate:fail-class:v1\b[^>]*-->/g;
const RE = /^<!--\s*gate:fail-class:v1\s+root=(\d+)\s+class=([a-z0-9][a-z0-9-]{0,47})\s+pr=(\d+)\s+sha=([a-f0-9]{40})\s*-->$/;

/** Pure: root-scoped items -> {failHistory:string[] (one entry per distinct failed pr+sha per class), records} | {error, detail}. */
export function resolveFailHistory(items, root) {
  if (!Array.isArray(items)) return { error: "fail_history_unavailable" };
  const seen = new Map();
  for (const it of items) {
    if (!isTrustedPm(it?.user)) continue; // spoofed receipts are ignored, never counted
    for (const raw of (it.body ?? "").match(ANY) ?? []) {
      const m = RE.exec(raw);
      if (!m) return { error: "fail_history_marker_malformed", detail: { marker: raw.slice(0, 120) } };
      if (Number(m[1]) !== root) return { error: "fail_history_other_root", detail: { expected: root, found: Number(m[1]) } };
      seen.set(`${m[2]}|${m[3]}|${m[4]}`, { class: m[2], pr: Number(m[3]), sha: m[4] });
    }
  }
  const records = [...seen.values()];
  return { failHistory: records.map((r) => r.class), records };
}
