import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'ecc/ecc.lock.json'), 'utf8'));

const REQUIRED = [
  '.claude/skills/verification-loop/SKILL.md',
  '.claude/skills/tdd-workflow/SKILL.md',
  '.claude/agents/build-error-resolver.md',
  '.claude/agents/react-build-resolver.md',
  '.claude/agents/code-reviewer.md',
  '.claude/agents/security-reviewer.md',
  '.claude/agents/typescript-reviewer.md',
  '.claude/agents/react-reviewer.md',
  '.claude/agents/planner.md',
  '.claude/agents/architect.md',
];

// 파일 내용이 lock 의 sha256 과 일치하는지 검사한다. 불일치 목록을 반환.
export function verifyLock(lockData, baseDir) {
  const problems = [];
  for (const dest of REQUIRED) {
    if (!lockData.files.some((f) => f.dest === dest)) problems.push(`lock 에 없음: ${dest}`);
  }
  for (const f of lockData.files) {
    const p = path.join(baseDir, f.dest);
    if (!fs.existsSync(p)) {
      problems.push(`파일 없음: ${f.dest}`);
      continue;
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (actual !== f.sha256) problems.push(`sha256 불일치: ${f.dest}`);
  }
  return problems;
}

test('lock 메타데이터', () => {
  assert.equal(lock.package, 'ecc-universal');
  assert.equal(lock.version, '2.2.3');
  assert.equal(lock.sourceCommit, 'c05b2d6');
  assert.equal(lock.files.length, 10);
  for (const f of lock.files) assert.match(f.sha256, /^[0-9a-f]{64}$/);
});

test('4개 파일이 존재하고 sha256 이 lock 과 일치', () => {
  assert.deepEqual(verifyLock(lock, root), []);
});

test('파일이 변경되면 검증이 실패', () => {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'ecc-lock-'));
  try {
    for (const f of lock.files) {
      const out = path.join(tmp, f.dest);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(path.join(root, f.dest), out);
    }
    assert.deepEqual(verifyLock(lock, tmp), []);
    fs.appendFileSync(path.join(tmp, lock.files[0].dest), 'x');
    assert.deepEqual(verifyLock(lock, tmp), [`sha256 불일치: ${lock.files[0].dest}`]);
    fs.rmSync(path.join(tmp, lock.files[1].dest));
    assert.equal(verifyLock(lock, tmp).length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
