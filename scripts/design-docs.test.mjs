// PRODUCT.md·DESIGN.md (Impeccable 형식 디자인 기준 문서)가 실제 코드와 맞는지 검사합니다.
// - DESIGN.md 색 토큰 표(`이름` | `#hex` | … | 출처)의 이름·값이 tailwind.config.ts 의 colors 와 같아야 합니다.
// - DESIGN.md frontmatter colors 도 같은 값이어야 합니다.
// - 'globals.css 고정값' 표의 값이 src/app/globals.css 에 그대로 있어야 합니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/** tailwind.config.ts 의 theme.extend.colors 를 { 'bg': '#0B1220', 'bg.raised': … } 로 읽습니다 (DEFAULT 는 부모 이름). */
export function parseTailwindColors(src) {
  const start = src.search(/colors\s*:\s*\{/);
  assert.ok(start >= 0, 'tailwind.config.ts 에 colors 블록이 없음');
  const out = {};
  const stack = [];
  let depth = 0;
  for (const raw of src.slice(src.indexOf('{', start) + 1).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    const open = line.match(/^["']?([\w-]+)["']?\s*:\s*\{\s*$/);
    const leaf = [...line.matchAll(/["']?([\w-]+)["']?\s*:\s*["'](#[0-9A-Fa-f]{3,8})["']/g)];
    if (open) { stack.push(open[1]); depth++; continue; }
    for (const [, k, v] of leaf) out[[...stack, k].filter((x) => x !== 'DEFAULT').join('.')] = v;
    if (/^\}/.test(line)) {
      if (depth === 0) break;
      stack.pop(); depth--;
    }
  }
  return out;
}

/** 표에서 `토큰` | `#hex` 로 시작하는 행을 읽습니다. */
export function parseDesignTokenRows(md) {
  return [...md.matchAll(/^\|\s*`([a-z][\w.-]*)`\s*\|\s*`(#[0-9A-Fa-f]{3,8})`\s*\|(.*)\|\s*$/gm)].map(([, name, hex, rest]) => ({ name, hex, rest }));
}

function frontmatterColors(md) {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(fm, 'DESIGN.md frontmatter 없음');
  const block = fm[1].match(/^colors:\n((?:[ \t]+.*\n?)*)/m);
  assert.ok(block, 'frontmatter 에 colors 없음');
  return Object.fromEntries([...block[1].matchAll(/^\s+"?([\w.-]+)"?\s*:\s*"(#[0-9A-Fa-f]{3,8})"/gm)].map(([, k, v]) => [k, v]));
}

function globalsRows(md) {
  const sec = md.split(/^### globals\.css 고정값\s*$/m)[1];
  assert.ok(sec, "DESIGN.md 에 '### globals.css 고정값' 절이 없음");
  const body = sec.split(/^#{2,3} /m)[0];
  return [...body.matchAll(/^\|[^|\n]*\|\s*`([^`]+)`\s*\|\s*([^|\n]+?)\s*\|\s*$/gm)].map(([, value, source]) => ({ value, source }));
}

test('PRODUCT.md·DESIGN.md 가 루트에 있음', () => {
  assert.ok(fs.existsSync(path.join(root, 'PRODUCT.md')), 'PRODUCT.md 없음');
  assert.ok(fs.existsSync(path.join(root, 'DESIGN.md')), 'DESIGN.md 없음');
  assert.match(read('PRODUCT.md'), /<!-- impeccable:product-schema 1 -->/);
  assert.match(read('PRODUCT.md'), /Operate/);
});

test('DESIGN.md 색 토큰 표가 tailwind.config.ts 와 같음', () => {
  const tw = parseTailwindColors(read('tailwind.config.ts'));
  const rows = parseDesignTokenRows(read('DESIGN.md'));
  assert.ok(rows.length >= 1, '기계로 읽을 수 있는 색 토큰 행이 없음');
  for (const r of rows) {
    assert.ok(r.name in tw, `tailwind.config.ts 에 없는 토큰: ${r.name}`);
    assert.equal(r.hex, tw[r.name], `${r.name} 값이 다름`);
    assert.match(r.rest, /tailwind\.config\.ts/, `${r.name} 행에 출처 파일 없음`);
  }
  const listed = new Set(rows.map((r) => r.name));
  for (const k of Object.keys(tw)) assert.ok(listed.has(k), `DESIGN.md 표에 빠진 토큰: ${k}`);
});

test('DESIGN.md frontmatter colors 가 tailwind.config.ts 와 같음', () => {
  const tw = parseTailwindColors(read('tailwind.config.ts'));
  const fm = frontmatterColors(read('DESIGN.md'));
  assert.ok(Object.keys(fm).length >= 1);
  assert.deepEqual(fm, tw);
});

test('DESIGN.md 의 globals.css 고정값이 globals.css 에 있음', () => {
  const css = read('src/app/globals.css');
  const rows = globalsRows(read('DESIGN.md'));
  assert.ok(rows.length >= 1, 'globals.css 고정값 행이 없음');
  for (const r of rows) {
    assert.match(r.source, /globals\.css/, `${r.value} 출처 없음`);
    assert.ok(css.includes(r.value), `globals.css 에 없음: ${r.value}`);
  }
});

test('검사기가 어긋남을 잡아냄', () => {
  const tw = parseTailwindColors('colors: {\n  bg: {\n    DEFAULT: "#000000",\n    raised: "#111111",\n  },\n  ok: "#222222",\n},\nmaxWidth: {}');
  assert.deepEqual(tw, { bg: '#000000', 'bg.raised': '#111111', ok: '#222222' });
  const rows = parseDesignTokenRows('| `bg.raised` | `#999999` | 쓰임 | tailwind.config.ts |\n');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].hex, tw[rows[0].name]);
});
