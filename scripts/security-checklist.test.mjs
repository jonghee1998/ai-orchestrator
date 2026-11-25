// docs/SECURITY_CHECKLIST.md (0.18 정식 보안 점검표)가 실제 코드·테스트와 맞는지 검사합니다.
// - 표는 정확히 4열 '항목 | 구분 | 근거 | 상태', 구분은 '코드·CI' 또는 '운영 설정'.
// - 근거의 `경로` › "테스트 이름" 쌍은 그 파일에 test("이름" 으로 글자 그대로 있어야 합니다.
// - 필수 8쌍(REQUIRED_PAIRS)과 운영 설정 5개(REQUIRED_OPS)가 빠지면 실패합니다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = 'docs/SECURITY_CHECKLIST.md';

/** 저장소 루트 기준으로 읽습니다. 파일이 없거나 디렉터리면 null. */
export function readRepoFile(p) {
  try {
    const full = path.join(root, p);
    if (!full.startsWith(root + path.sep) || !fs.statSync(full).isFile()) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

export const KINDS = ['코드·CI', '운영 설정'];
export const OPS_STATUS = '사람 확인';

export const REQUIRED_PAIRS = [
  ['src/lib/session/admission.test.ts', 'wrong-password throttling: five failures then 429 with Retry-After, even for the right password; expiry resets'],
  ['src/lib/session/admission.test.ts', 'forwarded headers are not trusted: spoofing x-forwarded-for / x-real-ip / forwarded cannot rotate buckets'],
  ['src/lib/session/session.test.ts', 'login with admin token issues HttpOnly Secure SameSite cookie; no raw token anywhere'],
  ['src/lib/session/session.test.ts', 'guard CSRF: cookie-auth mutation requires matching x-csrf-token and same Origin'],
  ['src/lib/session/session.test.ts', 'guard: session reads allowed; read-role cannot do admin; unsigned cookie rejected'],
  ['src/lib/orch/github.test.ts', 'route POST scope all: read session, missing/wrong CSRF, no auth, bad input, no write token → zero GitHub calls'],
  ['src/lib/session/password.test.ts', 'password hash is fixed-cost salted scrypt; plaintext/malformed/weak costs fail closed'],
  ['scripts/orch/core.test.mjs', 'PR marker and protected paths'],
];

export const REQUIRED_OPS = ['main 브랜치 보호', 'BOT_PAT', 'ORCH_GITHUB_TOKEN', 'Vercel 환경변수', 'CODEX_AUTH_KEY'];

const FORWARDED_PAIR = REQUIRED_PAIRS[1];
const PROTECTED_PAIR = REQUIRED_PAIRS[7];
const SECRET_PATTERNS = ['ghp_', 'github_pat_', 'sk-', 'BEGIN PRIVATE KEY'];
const PAIR_RE = /`([^`]+)`\s*›\s*"([^"]+)"/g;
const PATH_RE = /`((?:src|scripts|docs)\/[^`]*)`/g;

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const isSeparator = (line) => /^\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line.trim());
const hasPair = (pairs, [p, n]) => pairs.some((x) => x.path === p && x.name === n);

/**
 * 점검표 문자열을 검사해 오류 문자열 배열을 돌려줍니다 (빈 배열이면 통과).
 * readFile(경로) → 파일 내용 문자열, 없으면 null.
 */
export function checkChecklist(md, readFile) {
  const errors = [];
  for (const pat of SECRET_PATTERNS) if (md.includes(pat)) errors.push(`비밀값 패턴이 문서에 있음: ${pat}`);

  const tableLines = md.split('\n').filter((l) => l.trim().startsWith('|'));
  const header = tableLines[0];
  if (header && cellsOf(header).join(' | ') !== '항목 | 구분 | 근거 | 상태') errors.push(`표 머리가 '항목 | 구분 | 근거 | 상태'가 아님: ${header}`);
  const rows = tableLines.slice(1).filter((l) => !isSeparator(l)).map((line) => ({ line, cells: cellsOf(line) }));
  if (rows.length === 0) {
    errors.push('표 행이 없음');
    return errors;
  }

  const parsed = [];
  for (const { line, cells } of rows) {
    if (cells.length !== 4) {
      errors.push(`열 수가 4가 아님(${cells.length}): ${line}`);
      continue;
    }
    const [item, kind, evidence, status] = cells;
    if (!KINDS.includes(kind)) errors.push(`구분 값이 잘못됨(${kind}): ${item}`);
    if (kind === '운영 설정' && status !== OPS_STATUS) errors.push(`운영 설정 상태가 '${OPS_STATUS}'가 아님(${status}): ${item}`);

    for (const [, p] of line.matchAll(PATH_RE)) if (readFile(p) === null) errors.push(`없는 파일 경로: ${p}`);

    const pairs = [...evidence.matchAll(PAIR_RE)].map(([, p, name]) => ({ path: p, name }));
    for (const { path: p, name } of pairs) {
      const src = readFile(p);
      if (src !== null && !src.includes(`test("${name}"`)) errors.push(`테스트 이름이 ${p} 에 없음: "${name}"`);
    }
    if (kind === '코드·CI' && pairs.length === 0) errors.push(`코드·CI 행에 \`경로\` › "테스트 이름" 근거가 없음: ${item}`);
    parsed.push({ item, kind, evidence, line, pairs });
  }

  const codeRows = parsed.filter((r) => r.kind === '코드·CI');
  const opsRows = parsed.filter((r) => r.kind === '운영 설정');
  for (const pair of REQUIRED_PAIRS) {
    if (!codeRows.some((r) => hasPair(r.pairs, pair))) errors.push(`필수 근거 쌍이 코드·CI 행에 없음: ${pair[0]} › "${pair[1]}"`);
  }
  for (const kw of REQUIRED_OPS) {
    if (!opsRows.some((r) => r.item.includes(kw))) errors.push(`운영 설정 행 항목에 '${kw}'가 없음`);
  }

  const protectedRow = codeRows.find((r) => hasPair(r.pairs, PROTECTED_PAIR));
  if (protectedRow && !protectedRow.evidence.includes('`scripts/orch/main.mjs`')) errors.push('보호 경로 행 근거에 `scripts/orch/main.mjs`가 없음');

  const forwardedRow = codeRows.find((r) => hasPair(r.pairs, FORWARDED_PAIR));
  if (forwardedRow) {
    if (!forwardedRow.line.includes('`src/lib/session/rate-limit.ts`')) errors.push('전달 헤더 행에 `src/lib/session/rate-limit.ts`가 없음');
    if (!forwardedRow.line.includes('x-vercel-forwarded-for')) errors.push("전달 헤더 행에 'x-vercel-forwarded-for' 설명이 없음");
  }
  return errors;
}

const doc = () => {
  const md = readRepoFile(DOC);
  assert.ok(md !== null, `${DOC} 가 없음`);
  return md;
};
const failsWith = (md) => {
  const errs = checkChecklist(md, readRepoFile);
  assert.ok(errs.length >= 1, '변형한 점검표가 통과하면 안 됨');
  return errs;
};
const lineWith = (md, s) => {
  const l = md.split('\n').find((x) => x.startsWith('|') && x.includes(s));
  assert.ok(l, `행을 찾지 못함: ${s}`);
  return l;
};

test('security checklist: real document has zero errors', () => {
  assert.deepEqual(checkChecklist(doc(), readRepoFile), []);
});

test('security checklist: required pairs/ops constants are complete', () => {
  assert.equal(REQUIRED_PAIRS.length, 8);
  assert.equal(REQUIRED_OPS.length, 5);
  const md = doc();
  const opsRows = md.split('\n').filter((l) => l.includes('| 운영 설정 |'));
  assert.equal(opsRows.length, 5);
  for (const l of opsRows) assert.ok(l.trim().endsWith('| 사람 확인 |'));
});

test('security checklist: mutated copies fail (document file is not changed)', () => {
  const md = doc();
  const del = (s) => md.split('\n').filter((l) => l !== lineWith(md, s)).join('\n');

  // 필수 행 하나 삭제 (다른 정상 행은 남음)
  const noCsrf = del('guard CSRF: cookie-auth mutation');
  assert.ok(noCsrf.includes('wrong-password throttling'));
  assert.ok(failsWith(noCsrf).some((e) => e.includes('필수 근거 쌍')));

  // 운영 설정 행 하나 삭제
  assert.ok(failsWith(del('CODEX_AUTH_KEY')).some((e) => e.includes('CODEX_AUTH_KEY')));

  // 테스트 이름 한 글자 변경
  assert.ok(failsWith(md.replace('PR marker and protected paths"', 'PR marker and protected pathz"')).some((e) => e.includes('테스트 이름')));

  // 없는 경로로 변경
  assert.ok(failsWith(md.replace('`src/lib/session/password.test.ts`', '`src/lib/session/nope.test.ts`')).some((e) => e.includes('없는 파일 경로')));

  // 열 하나 추가
  const row = lineWith(md, 'main 브랜치 보호');
  assert.ok(failsWith(md.replace(row, `${row} 추가 |`)).some((e) => e.includes('열 수')));

  // 구분을 다른 값으로 변경
  assert.ok(failsWith(md.replace(row, row.replace('| 운영 설정 |', '| 기타 |'))).some((e) => e.includes('구분 값')));

  // 운영 상태를 '완료'로 변경
  assert.ok(failsWith(md.replace(row, row.replace('| 사람 확인 |', '| 완료 |'))).some((e) => e.includes('운영 설정 상태')));

  // 표 전체 삭제
  const noTable = md.split('\n').filter((l) => !l.trim().startsWith('|')).join('\n');
  assert.ok(failsWith(noTable).some((e) => e.includes('표 행이 없음')));

  // ghp_ 삽입
  assert.ok(failsWith(`${md}\nghp_\n`).some((e) => e.includes('ghp_')));

  // 파일은 그대로
  assert.equal(readRepoFile(DOC), md);
});

test('security checklist: protected-path and forwarded-header rows keep their code evidence', () => {
  const md = doc();
  const prot = lineWith(md, 'PR marker and protected paths');
  assert.ok(failsWith(md.replace(prot, prot.replace('`scripts/orch/main.mjs`', 'main.mjs'))).some((e) => e.includes('main.mjs')));
  const fwd = lineWith(md, 'forwarded headers are not trusted');
  assert.ok(failsWith(md.replace(fwd, fwd.replace('`src/lib/session/rate-limit.ts`', 'rate-limit'))).some((e) => e.includes('rate-limit.ts')));
  assert.ok(failsWith(md.replace(fwd, fwd.replaceAll('x-vercel-forwarded-for', 'vercel header'))).some((e) => e.includes('x-vercel-forwarded-for')));
});
