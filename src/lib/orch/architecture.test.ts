import assert from "node:assert/strict";
import test from "node:test";
import { ARCH_MAX_BYTES, parseArchitecture, type ArchBlock } from "./model";

const text = { type: "text", lines: ["요청을 받아 계획을 세운다"] };
const table = { type: "table", head: ["이름", "역할"], rows: [["엔진", "스텝 실행"], ["상황판", "보기"]] };
const box = (extra: Record<string, unknown> = {}) => ({ x: 10, y: 10, w: 100, h: 40, lines: ["계획"], tone: "accent", ...extra });
const diagram = (extra: Record<string, unknown> = {}) => ({
  type: "diagram", width: 300, height: 200, label: "흐름 그림", boxes: [box()], arrows: [{ points: [[110, 30], [200, 30]] }], caption: "화살표 = 순서", ...extra,
});
const doc = (sections: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ version: 1, purpose: "예시 프로젝트 목적", sections, ...extra });
const section = (blocks: unknown[], extra: Record<string, unknown> = {}) => ({ no: "01", kicker: "개요", title: "한눈에 보기", blocks, ...extra });
const blocksOf = (blocks: unknown[]): ArchBlock[] => parseArchitecture(doc([section(blocks)]))?.sections[0].blocks ?? [];
const diag = (extra: Record<string, unknown>) => blocksOf([diagram(extra)])[0] as Extract<ArchBlock, { type: "diagram" }> | undefined;

test("parseArchitecture: a well-formed document keeps every field", () => {
  const a = parseArchitecture(doc([section([text, table, diagram()])]));
  assert.deepEqual(a, {
    version: 1, purpose: "예시 프로젝트 목적",
    sections: [{ no: "01", kicker: "개요", title: "한눈에 보기", blocks: [
      { type: "text", lines: ["요청을 받아 계획을 세운다"] },
      { type: "table", head: ["이름", "역할"], rows: [["엔진", "스텝 실행"], ["상황판", "보기"]] },
      { type: "diagram", width: 300, height: 200, label: "흐름 그림", boxes: [{ x: 10, y: 10, w: 100, h: 40, lines: ["계획"], tone: "accent" }], arrows: [{ points: [[110, 30], [200, 30]] }], caption: "화살표 = 순서" },
    ] }],
  });
});

test("parseArchitecture: over 65,536 UTF-8 bytes → null (multi-byte chars counted as bytes)", () => {
  const base = doc([section([text])], { pad: "" });
  const fill = (n: number) => doc([section([text])], { pad: "a".repeat(n) });
  const exact = fill(ARCH_MAX_BYTES - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(exact), ARCH_MAX_BYTES);
  assert.ok(parseArchitecture(exact), "exactly 64KB is fine");
  assert.equal(parseArchitecture(fill(ARCH_MAX_BYTES - Buffer.byteLength(base) + 1)), null);
  const ko = doc([section([text])], { pad: "가".repeat(22_000) }); // 66,000+ bytes but < 65,536 chars
  assert.ok(ko.length < ARCH_MAX_BYTES && Buffer.byteLength(ko) > ARCH_MAX_BYTES);
  assert.equal(parseArchitecture(ko), null);
});

test("parseArchitecture: string length caps cut the text", () => {
  const a = parseArchitecture(doc([section([
    { type: "text", lines: ["문".repeat(130)] },
    { type: "table", head: ["열".repeat(50)], rows: [["칸".repeat(50)]] },
    diagram({ label: "설".repeat(130), caption: "범".repeat(90), boxes: [box({ lines: ["가".repeat(18), "나".repeat(19)] })] }),
  ], { kicker: "분".repeat(20), title: "제".repeat(50) })], { purpose: "목".repeat(70) }));
  assert.ok(a);
  assert.equal(a.purpose, "목".repeat(60));
  const s = a.sections[0];
  assert.equal(s.kicker, "분".repeat(12));
  assert.equal(s.title, "제".repeat(40));
  const [t, tb, d] = s.blocks as [Extract<ArchBlock, { type: "text" }>, Extract<ArchBlock, { type: "table" }>, Extract<ArchBlock, { type: "diagram" }>];
  assert.equal(t.lines[0], "문".repeat(120));
  assert.equal(tb.head[0], "열".repeat(40));
  assert.equal(tb.rows[0][0], "칸".repeat(40));
  assert.equal(d.label, "설".repeat(120));
  assert.equal(d.caption, "범".repeat(80));
  assert.deepEqual(d.boxes[0].lines, ["가".repeat(18), "나".repeat(17) + "…"], "18 chars kept, longer → ellipsis within 18");
});

test("parseArchitecture: count caps (sections 12, blocks 6, text 8 lines, table 4×20, boxes 24, arrows 30, box lines 3)", () => {
  const many = Array.from({ length: 15 }, (_, i) => section([text], { no: String(i + 1).padStart(2, "0") }));
  assert.equal(parseArchitecture(doc(many))?.sections.length, 12);
  assert.equal(blocksOf(Array(9).fill(text)).length, 6);
  const [t] = blocksOf([{ type: "text", lines: Array.from({ length: 10 }, (_, i) => `줄${i}`) }]) as Extract<ArchBlock, { type: "text" }>[];
  assert.equal(t.lines.length, 8);
  const [tb] = blocksOf([{ type: "table", head: ["a", "b", "c", "d", "e"], rows: Array.from({ length: 25 }, () => ["1", "2", "3", "4", "5"]) }]) as Extract<ArchBlock, { type: "table" }>[];
  assert.deepEqual(tb.head, ["a", "b", "c", "d"]);
  assert.equal(tb.rows.length, 20);
  assert.deepEqual(tb.rows[0], ["1", "2", "3", "4"]);
  const d = diag({
    height: 1200,
    boxes: Array.from({ length: 30 }, (_, i) => box({ y: i * 40, h: 30, lines: ["1", "2", "3", "4"] })),
    arrows: Array.from({ length: 35 }, () => ({ points: [[0, 0], [10, 10]] })),
  });
  assert.equal(d?.boxes.length, 24);
  assert.equal(d?.boxes[0].lines.length, 3);
  assert.equal(d?.arrows.length, 30);
});

test("parseArchitecture: out-of-range, NaN-like, negative or overflowing boxes are dropped one by one", () => {
  const bad = [
    box({ x: -1 }), box({ y: -0.5 }), box({ w: -10 }), box({ w: 0 }), box({ h: 0 }), box({ x: 250, w: 60 }), box({ y: 180, h: 30 }),
    box({ x: "10" }), box({ x: null }), box({ x: Infinity }), box({ lines: [] }), box({ lines: [" ", 3] }), "상자",
  ];
  const d = diag({ boxes: [...bad, box({ x: 200, w: 100, y: 160, h: 40, tone: "weird" })] });
  assert.deepEqual(d?.boxes, [{ x: 200, y: 160, w: 100, h: 40, lines: ["계획"], tone: "plain" }], "edge (x+w=300, y+h=height) kept; unknown tone → plain");
  // JSON has no NaN literal; a NaN-producing value arrives as null/string and is rejected above. Check the raw parser path too.
  assert.equal(diag({ boxes: [box({ x: Number.NaN })] }), undefined, "NaN → null in JSON → box dropped → no boxes → block dropped");
});

test("parseArchitecture: diagram width must be 300 and height an integer 40~1200", () => {
  for (const extra of [{ width: 320 }, { height: 39 }, { height: 1201 }, { height: 100.5 }, { height: "200" }]) {
    assert.equal(diag(extra), undefined, JSON.stringify(extra));
  }
  assert.equal(diag({ height: 40, boxes: [box({ h: 30 })] })?.height, 40);
});

test("parseArchitecture: arrows need 2~6 points, each inside the drawing", () => {
  const p = (n: number) => Array.from({ length: n }, (_, i) => [i * 10, i * 10]);
  const d = diag({ arrows: [
    { points: p(1) }, { points: p(7) }, { points: [[0, 0], [301, 10]] }, { points: [[0, 0], [10, 201]] }, { points: [[-1, 0], [10, 10]] },
    { points: [[0, 0], [10]] }, { points: [[0, 0], ["1", 2]] }, { points: "x" }, {},
    { points: p(2) }, { points: p(6) }, { points: [[300, 200], [0, 0]] },
  ] });
  assert.deepEqual(d?.arrows.map((a) => a.points.length), [2, 6, 2]);
});

test("parseArchitecture: HTML stays a plain string (no parsing, no stripping)", () => {
  const html = "<img src=x onerror=alert(1)>";
  const a = parseArchitecture(doc([section([{ type: "text", lines: [html] }, { type: "table", head: ["<b>열</b>"], rows: [["<script>x</script>"]] }], { title: "<h1>제목</h1>" })], { purpose: "<i>목적</i>" }));
  assert.equal(a?.purpose, "<i>목적</i>");
  assert.equal(a?.sections[0].title, "<h1>제목</h1>");
  assert.deepEqual(a?.sections[0].blocks, [{ type: "text", lines: [html] }, { type: "table", head: ["<b>열</b>"], rows: [["<script>x</script>"]] }]);
});

test("parseArchitecture: broken blocks/sections dropped; nothing valid left → null", () => {
  const a = parseArchitecture(doc([
    section([{ type: "video" }, { type: "text", lines: [] }, { type: "table", head: [], rows: [["x"]] }, { type: "table", head: ["a"], rows: [] }, text]),
    section([{ type: "text", lines: [1, null] }]),
    { no: "03", title: "", blocks: [text] }, { title: "번호 없음", blocks: [text] }, "섹션", null,
  ]));
  assert.equal(a?.sections.length, 1);
  assert.deepEqual(a?.sections[0].blocks, [{ type: "text", lines: ["요청을 받아 계획을 세운다"] }]);
  for (const t of [doc([section([{ type: "video" }])]), doc([]), JSON.stringify({ version: 1 }), "[]", "not json", "", null, undefined]) {
    assert.equal(parseArchitecture(t), null, String(t));
  }
  assert.equal(parseArchitecture(doc([section([text])], { purpose: 5, version: "x" }))?.purpose, null, "purpose optional");
  assert.equal(parseArchitecture(doc([section([text])], { version: "x" }))?.version, 1);
});

test("docs/NEW_PROJECT.md: the sample architecture.json parses with nothing dropped", async () => {
  const { readFileSync } = await import("node:fs");
  const md = readFileSync("docs/NEW_PROJECT.md", "utf8");
  const m = md.match(/```json\n([\s\S]*?)\n```/);
  assert.ok(m, "json sample present");
  const raw = JSON.parse(m[1]);
  const a = parseArchitecture(m[1]);
  assert.ok(a);
  assert.equal(a.purpose, raw.purpose);
  assert.equal(a.sections.length, 1);
  assert.equal(a.sections[0].no, "01");
  assert.deepEqual(a.sections[0].blocks.map((b) => b.type), ["text", "diagram", "table"]);
  const d = a.sections[0].blocks[1];
  assert.ok(d.type === "diagram");
  assert.equal(d.boxes.length, raw.sections[0].blocks[1].boxes.length);
  assert.equal(d.arrows.length, raw.sections[0].blocks[1].arrows.length);
});
