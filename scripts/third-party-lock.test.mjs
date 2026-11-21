// Third-party skills (non-ECC) are vendored verbatim and pinned by sha256 in ecc/third-party.lock.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'ecc/third-party.lock.json'), 'utf8'));
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

test('impeccable: pinned source, license kept, no bundled binaries', () => {
  const t = lock.tools.find((x) => x.name === 'impeccable');
  assert.ok(t, 'impeccable entry');
  assert.match(t.sourceCommit, /^[0-9a-f]{40}$/);
  assert.equal(t.license, 'Apache-2.0');
  const dir = path.join(root, t.dest);
  assert.ok(fs.existsSync(path.join(dir, 'LICENSE')), 'license file shipped with the skill');
  assert.ok(!fs.existsSync(path.join(dir, 'scripts/bin')), 'downloaded engine binaries are never committed');
});

test('third-party lock: every file matches and nothing extra is present', () => {
  for (const t of lock.tools) {
    const listed = new Set(t.files.map((f) => f.path));
    for (const f of t.files) {
      const p = path.join(root, f.path);
      assert.ok(fs.existsSync(p), `missing ${f.path}`);
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'), f.sha256, `changed ${f.path}`);
    }
    const actual = walk(path.join(root, t.dest)).map((p) => path.relative(root, p).split(path.sep).join('/'));
    assert.deepEqual(actual.filter((p) => !listed.has(p)), [], `unlisted files in ${t.dest}`);
  }
});
