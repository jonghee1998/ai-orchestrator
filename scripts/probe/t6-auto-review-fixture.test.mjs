import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeChecks } from './t6-auto-review-fixture.mjs';

test('returns ready only if all checks pass', () => {
  assert.deepEqual(summarizeChecks(['passed', 'passed']), {
    total: 2, passed: 2, failed: 0, pending: 0, ready: true,
  });
});

test('fails closed when checks are missing or incomplete', () => {
  assert.equal(summarizeChecks([]).ready, false);
  assert.equal(summarizeChecks(['passed', 'waiting']).ready, false);
  assert.equal(summarizeChecks(['failed']).ready, false);
});

test('rejects malformed input', () => {
  assert.throws(() => summarizeChecks(null), TypeError);
});
