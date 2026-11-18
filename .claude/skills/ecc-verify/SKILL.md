---
name: ecc-verify
description: Run this repository's local self-verification (typecheck, unit tests, build, login smoke, read-only ECC project check, diff review) and write a G3 self-verification receipt bound to the exact HEAD SHA. Use after finishing a change and before opening or updating a PR. The receipt is local evidence only; it never stands in for CI, Codex review, security review or E2E.
license: MIT
metadata:
  origin: "ECC verification-loop @ 3f14a103a8694e51c1df9a806217a6d0b5f7a6f7 (adapted)"
---

# ECC Verify (adapted for ai-orchestrator)

Adapted from ECC `skills/verification-loop/SKILL.md` (MIT, pinned in `ecc/ecc.lock.json`).
Changes from upstream: uses this repository's real scripts, drops coverage flags the
`npm test` shell script does not accept, replaces the noisy `grep "sk-"` phase with the
read-only `npm run ecc:check`, and binds the report to the exact HEAD.

## Authority

This is **G3 self verification** (docs/QUALITY_GATES.md on PR #196). It is advisory.
- CI success, Codex independent review, security review and real E2E are separate gates.
  Never report any of them as PASS based on this skill.
- If any phase cannot run, the phase is `NOT_RUN` with the reason. Never mark it PASS.
- Contradictory results on the same SHA (for example an earlier PASS and a later FAIL)
  mean the overall result is FAIL. Do not pick the favourable one.

## Phases

Run from the repository root. Record the exact SHA first:

```bash
git rev-parse HEAD
git status --porcelain
```

If the working tree is dirty, the receipt covers the working tree, not the SHA. Say so.

1. Types: `npm run typecheck`
2. Unit tests: `npm test`
3. Build: `npm run build`
4. Login smoke: `node --test scripts/login-smoke.test.mjs`
5. ECC project check (read-only, no network): `npm run ecc:check`
   exit 0 = pass, 1 = fail, 2 = blocked. Its JSON output says `authoritative: false`.
6. Diff review: `git diff --stat <base-sha>...HEAD`. Check every changed file for
   unintended changes, missing error handling and untested failure paths.

Stop at the first failing phase only if later phases depend on it (a type error can still
be followed by the project check). Report every phase.

## Receipt format

```
SELF-VERIFICATION RECEIPT (G3, advisory)
HEAD:        <full 40-char sha>   tree: clean|dirty
Base:        <full base sha>
Types:       PASS|FAIL|NOT_RUN (<reason>)
Tests:       PASS|FAIL|NOT_RUN (<passed>/<total>)
Build:       PASS|FAIL|NOT_RUN
Login smoke: PASS|FAIL|NOT_RUN
ECC check:   PASS|FAIL|BLOCKED|NOT_RUN (<errors> errors, <warnings> warnings)
Diff:        <n> files changed
Overall:     READY_FOR_PR | NOT_READY
Not covered: CI, Codex review, security review, E2E, owner approval
```

Post the receipt in the PR or task issue only with the exact HEAD it covers. A new commit
makes the receipt stale.
