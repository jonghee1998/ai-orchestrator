// Issue #79 regressions: PR77 findings r4577560666 (Opus label) and r4577560671 (namespace replacement).
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubLabelAdapter, dispatchIssue, hasExactHandoff, replaceHandoffLabels } from "./dispatcher";
import { MemoryRunStore } from "./store";
import { mutateControl } from "../control/service";
import { retryDispatchRecord } from "./service";
import { normalizeIssues, planDispatch } from "../github/work-queue";
import { buildEvidence } from "../github/evidence";


const NOW = "2026-01-01T00:00:00.000Z";
type Call = { method: string; url: string; body?: unknown; headers: Record<string, string> };

/** In-memory GitHub issue-labels API (GET issue, PUT set-labels with real replace semantics). */
function fakeGitHub(initial: string[], opts: { state?: string; read?: () => Response | never; write?: (labels: string[]) => Response | never } = {}) {
  let labels = [...initial]; const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET"; const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method, url, body, headers: init.headers as Record<string, string> });
    if (method === "GET") {
      if (opts.read) return opts.read();
      return Response.json({ number: 1, state: opts.state ?? "open", labels: labels.map((name) => ({ name })) });
    }
    if (method === "PUT") {
      if (opts.write) return opts.write(body.labels);
      labels = [...new Set<string>(body.labels)];
      return Response.json(labels.map((name) => ({ name })));
    }
    return new Response("", { status: 405 }); // POST (append) must never be used any more
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, labels: () => labels };
}
const rec = (agent: string, issueNumber = 1) => ({ dispatchId: `d-${issueNumber}-${agent}-1`, issueNumber, agent } as never);
const adapter = (f: typeof fetch) => new GitHubLabelAdapter({ token: "tok", repo: "o/r" }, f);
const queue = (labels: string[]) => normalizeIssues([{ number: 1, title: "t", body: null, html_url: "u", state: "open", labels }]);

test("finding 1: claude-opus emits agent:opus; sonnet stays agent:claude; codex stays agent:codex", async () => {
  for (const [agent, label] of [["claude-opus", "agent:opus"], ["claude-sonnet", "agent:claude"], ["codex", "agent:codex"]]) {
    const gh = fakeGitHub(["bug"]);
    assert.equal((await adapter(gh.fetchImpl).submit(rec(agent), "k")).outcome, "accepted");
    assert.deepEqual(gh.calls.map((c) => c.method), ["GET", "PUT"]);
    assert.equal(gh.calls[1].url, "https://api.github.com/repos/o/r/issues/1/labels");
    assert.deepEqual(gh.calls[1].body, { labels: ["bug", label, "status:ready"] });
    assert.ok(!JSON.stringify(gh.calls.map((c) => c.body)).includes("tok"));
  }
});

test("finding 1 downstream: mocked Opus submission normalizes to opus in queue, plan and evidence", async () => {
  const s = new MemoryRunStore();
  await mutateControl(s, { action: "set_agent", agent: "claude-opus", enabled: true }, "t", NOW);
  await mutateControl(s, { action: "set_claude_provider", enabled: true }, "t", NOW);
  const gh = fakeGitHub(["status:backlog"]);
  const r = await dispatchIssue(s, adapter(gh.fetchImpl), 1, "claude-opus", NOW);
  assert.equal(r.ok && r.record.submission, "accepted");
  const labels = gh.labels();
  assert.deepEqual(labels, ["agent:opus", "status:ready"]);
  const [task] = queue(labels);
  assert.deepEqual([task.agent, task.status], ["opus", "ready"]);
  assert.equal(planDispatch([task])[0].eligible, true);
  const ev = buildEvidence({ repo: "o/r", generatedAt: NOW, issues: [{ number: 1, title: "t", body: null, html_url: "u", state: "open", labels: labels.map((name) => ({ name })) } as never], pulls: [], comments: [], pullDetail: new Map(), commentsTruncated: false, pullsTruncated: false });
  assert.deepEqual([ev.issues[0].agent, ev.issues[0].status], ["opus", "ready"]);
});

test("finding 2: Claude(review) -> Codex(ready) -> back to Claude replaces namespaces, keeps unrelated labels", async () => {
  const gh = fakeGitHub(["priority:high", "agent:claude", "bug", "status:review"]);
  const ad = adapter(gh.fetchImpl);
  assert.equal((await ad.submit(rec("codex"), "k1")).outcome, "accepted");
  assert.deepEqual(gh.labels(), ["priority:high", "bug", "agent:codex", "status:ready"]);
  let [t] = queue(gh.labels());
  assert.deepEqual([t.agent, t.status, planDispatch([t])[0].reasons], ["codex", "ready", []]);

  // Codex finishes and someone flips status to review; return to Claude.
  gh.labels().splice(gh.labels().indexOf("status:ready"), 1, "status:review");
  assert.equal((await ad.submit(rec("claude-sonnet"), "k2")).outcome, "accepted");
  assert.deepEqual(gh.labels(), ["priority:high", "bug", "agent:claude", "status:ready"]);
  [t] = queue(gh.labels());
  assert.deepEqual([t.agent, t.status, planDispatch([t])[0].eligible], ["claude", "ready", true]);
  assert.ok(hasExactHandoff(gh.labels(), "agent:claude"));
});

test("namespace replacement helper: drops all prior agent:/status: (incl. multiples/unknown), dedups, preserves order", () => {
  assert.deepEqual(replaceHandoffLabels(["a", "agent:claude", "agent:opus", "status:done", "status:weird", "a", "agentish", "statusx"], "agent:codex"),
    ["a", "agentish", "statusx", "agent:codex", "status:ready"]);
  assert.deepEqual(replaceHandoffLabels([], "agent:opus"), ["agent:opus", "status:ready"]);
  assert.equal(hasExactHandoff(["agent:opus", "agent:claude", "status:ready"], "agent:opus"), false);
  assert.equal(hasExactHandoff(["agent:opus", "status:ready", "status:review"], "agent:opus"), false);
});

test("read failures are definite non-acceptance with zero writes (retryable); never unknown", async () => {
  const cases: Array<[string, Parameters<typeof fakeGitHub>[1]]> = [
    ["404", { read: () => new Response("", { status: 404 }) }],
    ["500", { read: () => new Response("", { status: 503 }) }],
    ["transport", { read: () => { throw new Error("secret-token-xyz"); } }],
    ["bad json", { read: () => new Response("not json", { status: 200 }) }],
    ["bad labels", { read: () => Response.json({ state: "open", labels: "x" }) }],
    ["closed", { state: "closed" }],
    ["pull request", { read: () => Response.json({ state: "open", labels: [], pull_request: {} }) }],
  ];
  for (const [name, o] of cases) {
    const gh = fakeGitHub(["agent:claude", "status:review"], o);
    const r = await adapter(gh.fetchImpl).submit(rec("codex"), "k");
    assert.equal(r.outcome, "rejected_not_accepted", name);
    assert.ok(!r.error?.includes("secret-token-xyz"), name);
    assert.deepEqual(gh.calls.map((c) => c.method), ["GET"], name);
    assert.deepEqual(gh.labels(), ["agent:claude", "status:review"], name);
  }
  // End-to-end: read failure => record rejected => explicit retry allowed (nothing was written).
  const s = new MemoryRunStore(); await mutateControl(s, { action: "preset", name: "claude-only" }, "t", NOW);
  const gh = fakeGitHub([], { read: () => new Response("", { status: 502 }) });
  assert.equal((await dispatchIssue(s, adapter(gh.fetchImpl), 7, "claude-sonnet", NOW)).ok, false);
  assert.equal((await retryDispatchRecord(s, 7, "claude-sonnet", NOW)).ok, true);
});

test("write failures: 4xx rejected; 5xx/408/transport/unverifiable/mismatch => unknown and not auto-retryable", async () => {
  const cases: Array<[string, (l: string[]) => Response, string]> = [
    ["422", () => new Response("", { status: 422 }), "rejected_not_accepted"],
    ["403", () => new Response("", { status: 403 }), "rejected_not_accepted"],
    ["500", () => new Response("", { status: 500 }), "unknown"],
    ["408", () => new Response("", { status: 408 }), "unknown"],
    ["transport", () => { throw new Error("secret-token-xyz"); }, "unknown"],
    ["2xx non-json", () => new Response("ok", { status: 200 }), "unknown"],
    ["2xx stale set (concurrent writer)", () => Response.json([{ name: "agent:claude" }, { name: "agent:codex" }, { name: "status:ready" }]), "unknown"],
    ["2xx dropped unrelated", () => Response.json([{ name: "agent:codex" }, { name: "status:ready" }]), "unknown"],
  ];
  for (const [name, write, expected] of cases) {
    const gh = fakeGitHub(["bug", "agent:claude", "status:review"], { write });
    const r = await adapter(gh.fetchImpl).submit(rec("codex"), "k");
    assert.equal(r.outcome, expected, name);
    assert.ok(!r.error?.includes("secret-token-xyz"), name);
  }
  const s = new MemoryRunStore(); await mutateControl(s, { action: "preset", name: "claude-only" }, "t", NOW);
  const gh = fakeGitHub([], { write: () => new Response("", { status: 504 }) });
  const r = await dispatchIssue(s, adapter(gh.fetchImpl), 8, "claude-sonnet", NOW);
  assert.equal(r.ok && r.record.submission, "unknown");
  assert.equal((await retryDispatchRecord(s, 8, "claude-sonnet", NOW)).ok, false);
});

test("repeated/concurrent submissions: store gate allows one provider write; replay of same set is idempotent", async () => {
  const s = new MemoryRunStore(); await mutateControl(s, { action: "preset", name: "claude-only" }, "t", NOW);
  const gh = fakeGitHub(["bug", "agent:codex", "status:review"]);
  const ad = adapter(gh.fetchImpl);
  const rs = await Promise.all([1, 2, 3].map(() => dispatchIssue(s, ad, 9, "claude-sonnet", NOW)));
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(gh.calls.filter((c) => c.method === "PUT").length, 1);
  const before = gh.labels();
  assert.equal((await ad.submit(rec("claude-sonnet", 9), "replay")).outcome, "accepted");
  assert.deepEqual(gh.labels(), before);
  // X-Idempotency-Key is sent only as a trace hint; it is not relied on for GitHub atomicity.
  assert.equal(gh.calls[0].headers["X-Idempotency-Key"], gh.calls[1].headers["X-Idempotency-Key"]);
});
