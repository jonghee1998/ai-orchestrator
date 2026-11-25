import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { ROADMAP_APP_LABEL_MAX, ROADMAP_NOTE_MAX, ROADMAP_TITLE_MAX, SELF_REPO, phaseStatus, deployEveryFromVars, isSelfRepo, parseRoadmap, parseRun, roadmapCount, type OrchRun, type OrchStatus, type RoadmapItem } from "./model";
import { readRepo } from "./github";

const REPO = "o/r";
const ENV = { ORCH_GITHUB_TOKEN: "t" };

test("parseRoadmap: valid file → items with null for missing note/ref", () => {
  const r = parseRoadmap(JSON.stringify({
    version: 1,
    setup: [{ id: "0.1", title: "목적", status: "done", note: "PRODUCT.md", ref: "PRODUCT.md" }, { id: "0.2", title: "스택", status: "doing" }],
    expansion: [{ id: "6.1", title: "연결", status: "todo", ref: 267 }],
  }))!;
  assert.equal(r.version, 1);
  assert.deepEqual(r.setup, [
    { id: "0.1", title: "목적", status: "done", note: "PRODUCT.md", ref: "PRODUCT.md", tasks: [] },
    { id: "0.2", title: "스택", status: "doing", note: null, ref: null, tasks: [] },
  ]);
  assert.deepEqual(r.expansion, [{ id: "6.1", title: "연결", status: "todo", note: null, ref: 267, tasks: [] }]);
});

test("parseRoadmap: not JSON / not an object → null; missing lists → []", () => {
  for (const t of ["", "{", "not json", "[1,2]", "null", "3", null, undefined]) assert.equal(parseRoadmap(t), null, String(t));
  assert.deepEqual(parseRoadmap("{}"), { version: 1, setup: [], expansion: [], phases: [], app: null });
  assert.deepEqual(parseRoadmap(JSON.stringify({ version: "x", setup: "no", expansion: {} })), { version: 1, setup: [], expansion: [], phases: [], app: null });
});

test("parseRoadmap app: https URL only, label cut to 12, missing/odd → null", () => {
  const app = (v: unknown) => parseRoadmap(JSON.stringify({ setup: [], app: v }))!.app;
  assert.deepEqual(app({ label: "가계부", url: "https://example.com/" }), { label: "가계부", url: "https://example.com/" });
  assert.deepEqual(app({ url: " https://app.example.com/x?y=1 " }), { label: null, url: "https://app.example.com/x?y=1" });
  assert.deepEqual(app({ label: "  ", url: "https://example.com/" }), { label: null, url: "https://example.com/" });
  assert.deepEqual(app({ label: 7, url: "https://example.com/" }), { label: null, url: "https://example.com/" });
  assert.equal(app({ label: "가".repeat(30), url: "https://example.com/" })!.label, "가".repeat(ROADMAP_APP_LABEL_MAX));
  assert.equal(ROADMAP_APP_LABEL_MAX, 12);
  for (const bad of [
    undefined, null, "https://example.com/", [], 3, {}, { label: "x" },
    { url: "http://example.com/" }, { url: "javascript:alert(1)" }, { url: "HTTPS://example.com/" }, { url: "//example.com/" },
    { url: "https://" }, { url: "https:// bad host" }, { url: "ftp://example.com/" }, { url: 42 }, { url: "" },
  ]) assert.equal(app(bad), null, JSON.stringify(bad));
  assert.equal(parseRoadmap("{}")!.app, null);
});

test("parseRoadmap: malformed items skipped, unknown status → todo, odd ref dropped", () => {
  const r = parseRoadmap(JSON.stringify({
    setup: [
      null, 3, "x", [], { title: "id 없음" }, { id: "0.1" }, { id: 1, title: "숫자 id" }, { id: " ", title: "빈 id" },
      { id: "0.2", title: "이상한 상태", status: "finished", ref: -1 },
      { id: "0.3", title: "상태 없음", ref: 1.5, note: 7 },
      { id: "0.4", title: "na", status: "na", ref: {} },
    ],
  }))!;
  assert.deepEqual(r.setup.map((i) => [i.id, i.status, i.ref, i.note]), [["0.2", "todo", null, null], ["0.3", "todo", null, null], ["0.4", "na", null, null]]);
});

test("parseRoadmap: long strings are cut (title 24, note 80)", () => {
  const r = parseRoadmap(JSON.stringify({ setup: [{ id: "0.1", title: "가".repeat(40), status: "done", note: "나".repeat(200) }] }))!;
  assert.equal(r.setup[0].title.length, ROADMAP_TITLE_MAX);
  assert.equal(r.setup[0].note!.length, ROADMAP_NOTE_MAX);
  assert.equal(ROADMAP_TITLE_MAX, 24);
  assert.equal(ROADMAP_NOTE_MAX, 80);
});

test("roadmapCount: na left out of the total", () => {
  const it = (status: RoadmapItem["status"]): RoadmapItem => ({ id: "x", title: "x", status, note: null, ref: null, tasks: [] });
  assert.deepEqual(roadmapCount([it("done"), it("done"), it("doing"), it("todo"), it("na")]), { done: 2, doing: 1, todo: 1, total: 4, text: "2/4" });
  assert.deepEqual(roadmapCount([]), { done: 0, doing: 0, todo: 0, total: 0, text: "0/0" });
  assert.deepEqual(roadmapCount([it("na")]), { done: 0, doing: 0, todo: 0, total: 0, text: "0/0" });
});

test("docs/roadmap.json: passes parseRoadmap unchanged, setup 20 + expansion 5", () => {
  const text = fs.readFileSync(path.join(process.cwd(), "docs", "roadmap.json"), "utf8");
  const raw = JSON.parse(text) as { setup: unknown[]; expansion: unknown[] };
  const r = parseRoadmap(text)!;
  assert.ok(r);
  assert.equal(r.version, 1);
  assert.equal(r.setup.length, 20);
  assert.equal(r.expansion.length, 5);
  assert.equal(raw.setup.length, 20, "no item skipped");
  assert.equal(raw.expansion.length, 5, "no item skipped");
  const status = (id: string) => r.setup.find((i) => i.id === id)?.status;
  assert.deepEqual([status("0.4"), status("0.9"), status("0.14"), status("0.18")], ["done", "done", "na", "done"]);
  assert.deepEqual(r.setup.map((i) => i.id), Array.from({ length: 20 }, (_, i) => `0.${i + 1}`));
  assert.deepEqual(r.expansion.map((i) => i.id), ["6.1", "6.2", "6.3", "6.4", "6.5"]);
  // nothing cut or defaulted: parsed items equal the file (missing note/ref → null)
  const norm = (i: Record<string, unknown>) => ({ id: i.id, title: i.title, status: i.status, note: i.note ?? null, ref: i.ref ?? null, tasks: [] });
  assert.deepEqual(r.setup, (raw.setup as Record<string, unknown>[]).map(norm));
  assert.deepEqual(r.expansion, (raw.expansion as Record<string, unknown>[]).map(norm));
  assert.deepEqual(roadmapCount(r.setup), { done: 19, doing: 0, todo: 0, total: 19, text: "19/19" });
  assert.deepEqual(roadmapCount(r.expansion).text, "0/5");
  assert.equal(roadmapCount(r.expansion).doing, 1);
  assert.equal(r.expansion.find((i) => i.id === "6.1")?.status, "doing");
});

test("deployEveryFromVars: positive integer, else 10", () => {
  const v = (value: string) => [{ name: "ORCH_DEPLOY_EVERY", value }];
  assert.equal(deployEveryFromVars([]), 10);
  assert.equal(deployEveryFromVars(v("5")), 5);
  assert.equal(deployEveryFromVars(v(" 20 ")), 20);
  for (const bad of ["", "0", "-3", "2.5", "abc", "1e3"]) assert.equal(deployEveryFromVars(v(bad)), 10, bad);
});

test("parseRun: maxRetries from plan max_retries, default 3", () => {
  const issue = (extra: object) => ({ number: 1, html_url: "u", title: "[plan] x", body: "```json\n" + JSON.stringify({ goal: "g", steps: [{ id: 1, title: "s" }], ...extra }) + "\n```" });
  assert.equal(parseRun(REPO, issue({}))!.maxRetries, 3);
  assert.equal(parseRun(REPO, issue({ max_retries: 1 }))!.maxRetries, 1);
  assert.equal(parseRun(REPO, issue({ max_retries: 0 }))!.maxRetries, 0);
  for (const bad of ["2", -1, 1.5, null]) assert.equal(parseRun(REPO, issue({ max_retries: bad }))!.maxRetries, 3, String(bad));
});

// ---------------------------------------------------------------- readRepo: roadmap + deploy pending

type Opts = { roadmap?: { status: number; body?: unknown }; compare?: { status: number; body?: unknown }; vars?: { name: string; value: string }[] | null };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/(.{60})/g, "$1\n"); // GitHub wraps base64 lines
const ROADMAP = JSON.stringify({ version: 1, setup: [{ id: "0.1", title: "목적", status: "done" }], expansion: [] });

function fake(o: Opts) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = new URL(url); const m = init?.method ?? "GET";
    calls.push(`${m} ${u.pathname}`);
    const json = (s: number, b: unknown) => new Response(JSON.stringify(b ?? {}), { status: s });
    if (m !== "GET") return json(500, {});
    if (u.pathname === `/repos/${REPO}/contents/docs/roadmap.json`) {
      const r = o.roadmap ?? { status: 200, body: { encoding: "base64", content: b64(ROADMAP) } };
      return json(r.status, r.body);
    }
    if (u.pathname === `/repos/${REPO}/compare/prod-deployed...main`) { const c = o.compare ?? { status: 404 }; return json(c.status, c.body); }
    if (u.pathname.endsWith("/actions/variables")) return o.vars === null ? json(403, {}) : json(200, { variables: o.vars ?? [] });
    if (u.pathname.endsWith("/issues")) return json(200, []);
    return json(404, {});
  }) as typeof fetch;
  return { f, calls };
}

test("readRepo: roadmap read from contents API (base64), deployPending counts merge commits only", async () => {
  const commits = [{ parents: [{}, {}] }, { parents: [{}] }, { parents: [{}, {}] }, { parents: [{}, {}, {}] }, {}, null];
  const g = fake({ compare: { status: 200, body: { commits } }, vars: [{ name: "ORCH_DEPLOY_EVERY", value: "7" }, { name: "ORCH_PAUSED", value: "on" }] });
  const v = await readRepo(REPO, ENV, g.f);
  assert.deepEqual(v.roadmap, { version: 1, setup: [{ id: "0.1", title: "목적", status: "done", note: null, ref: null, tasks: [] }], expansion: [], phases: [], app: null });
  assert.equal(v.roadmapError, null);
  assert.equal(v.deployPending, 3);
  assert.equal(v.deployEvery, 7);
  assert.equal(v.switches!.paused, true);
  assert.ok(g.calls.includes(`GET /repos/${REPO}/contents/docs/roadmap.json`));
  assert.ok(g.calls.includes(`GET /repos/${REPO}/compare/prod-deployed...main`));
  assert.ok(g.calls.every((c) => c.startsWith("GET ")), "reads only");
});

test("readRepo: roadmap 404 → null without error; no tag → deployPending null; default deployEvery 10", async () => {
  const v = await readRepo(REPO, ENV, fake({ roadmap: { status: 404 } }).f);
  assert.equal(v.roadmap, null);
  assert.equal(v.roadmapError, null);
  assert.equal(v.deployPending, null);
  assert.equal(v.deployEvery, 10);
  assert.deepEqual([v.runsError, v.switchesError, v.plansError, v.ideasError], [null, null, null, null]);
});

test("readRepo: roadmap 403/500/broken file → roadmapError, everything else intact", async () => {
  const cases: [Opts["roadmap"], RegExp][] = [
    [{ status: 403 }, /권한/],
    [{ status: 500 }, /GitHub 오류 500/],
    [{ status: 200, body: { encoding: "base64", content: b64("{ broken") } }, /형식 오류/],
    [{ status: 200, body: [] }, /내용 없음/],
  ];
  for (const [roadmap, re] of cases) {
    const v = await readRepo(REPO, ENV, fake({ roadmap, compare: { status: 200, body: { commits: [{ parents: [{}, {}] }] } }, vars: [] }).f);
    assert.equal(v.roadmap, null);
    assert.match(v.roadmapError ?? "", re, JSON.stringify(roadmap));
    assert.ok(v.switches);
    assert.equal(v.deployPending, 1);
    assert.deepEqual([v.runsError, v.switchesError, v.plansError, v.ideasError], [null, null, null, null]);
  }
});

test("readRepo isSelf: ORCH_SELF_REPO set → that repo only; unset/blank → SELF_REPO", async () => {
  assert.equal(SELF_REPO, "jonghee1998/ai-orchestrator");
  const self = (repo: string, env: Record<string, string | undefined>) => readRepo(repo, { ...ENV, ...env }, fake({}).f).then((v) => v.isSelf);
  // ORCH_SELF_REPO 있음: 그 저장소만 자기 저장소 (공백은 잘라냄), SELF_REPO 는 아님
  assert.equal(await self(REPO, { ORCH_SELF_REPO: REPO }), true);
  assert.equal(await self(REPO, { ORCH_SELF_REPO: `  ${REPO} ` }), true);
  assert.equal(await self("o/other", { ORCH_SELF_REPO: REPO }), false);
  assert.equal(isSelfRepo(SELF_REPO, { ORCH_SELF_REPO: REPO }), false);
  // ORCH_SELF_REPO 없음·빈 값: SELF_REPO 상수
  assert.equal(await self(REPO, {}), false);
  assert.equal(await self(REPO, { ORCH_SELF_REPO: "   " }), false);
  assert.equal(isSelfRepo(SELF_REPO, {}), true);
  assert.equal(isSelfRepo(SELF_REPO, { ORCH_SELF_REPO: "" }), true);
});

test("readRepo: roadmap app passed through (https only)", async () => {
  const withApp = (app: unknown) => fake({ roadmap: { status: 200, body: { encoding: "base64", content: b64(JSON.stringify({ setup: [], app })) } } }).f;
  assert.deepEqual((await readRepo(REPO, ENV, withApp({ label: "앱", url: "https://example.com/" }))).roadmap!.app, { label: "앱", url: "https://example.com/" });
  assert.equal((await readRepo(REPO, ENV, withApp({ url: "http://example.com/" }))).roadmap!.app, null);
});

test("readRepo: variables unreadable → deployEvery 10; compare error → deployPending null", async () => {
  const v = await readRepo(REPO, ENV, fake({ vars: null, compare: { status: 500 } }).f);
  assert.equal(v.switches, null);
  assert.equal(v.deployEvery, 10);
  assert.equal(v.deployPending, null);
  assert.ok(v.roadmap);
});

test("parseRoadmap phases: normal, missing, malformed skipped, ref number/string", () => {
  const r = parseRoadmap(JSON.stringify({ phases: [
    { id: "1", title: "기획", status: "done", ref: 2 },
    { id: "2", title: "문서", ref: "docs/a.md" },
    { id: "3" }, "x", null,
  ] }))!;
  assert.deepEqual(r.phases, [
    { id: "1", title: "기획", status: "done", note: null, ref: 2, tasks: [] },
    { id: "2", title: "문서", status: "todo", note: null, ref: "docs/a.md", tasks: [] },
  ]);
  assert.deepEqual(parseRoadmap("{}")!.phases, []);
  assert.deepEqual(parseRoadmap(JSON.stringify({ phases: "no" }))!.phases, []);
  assert.equal(roadmapCount(r.phases).text, "1/2");
});

test("phaseStatus: run status overrides, no run keeps value, cancelled keeps, input untouched", () => {
  const it = (id: string, status: RoadmapItem["status"], ref: number | string | null): RoadmapItem => ({ id, title: id, status, note: null, ref, tasks: [] });
  const run = (number: number, status: OrchStatus) => ({ number, status }) as unknown as OrchRun;
  const doing: OrchStatus[] = ["implementing", "reviewing", "fixing", "finalizing", "awaiting_merge", "waiting", "blocked"];
  for (const s of doing) assert.equal(phaseStatus([it("a", "todo", 5)], [run(5, s)])[0].status, "doing", s);
  assert.equal(phaseStatus([it("a", "todo", 5)], [run(5, "done")])[0].status, "done");
  assert.equal(phaseStatus([it("a", "doing", 5)], [run(5, "cancelled")])[0].status, "doing");
  assert.equal(phaseStatus([it("a", "done", 9), it("b", "todo", "x"), it("c", "todo", null)], [run(5, "done")]).map((i) => i.status).join(), "done,todo,todo");
  const input = [it("a", "todo", 5)];
  const snap = JSON.stringify(input);
  const out = phaseStatus(input, [run(5, "done")]);
  assert.equal(JSON.stringify(input), snap);
  assert.notEqual(out[0], input[0]);
});
