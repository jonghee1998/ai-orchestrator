# T6 / root #146 — evidence-bound acceptance and deployment blocker register

**Source of truth:** root [#146](https://github.com/jonghee1998/ai-orchestrator/issues/146), child [#194](https://github.com/jonghee1998/ai-orchestrator/issues/194) / [#201](https://github.com/jonghee1998/ai-orchestrator/issues/201), common rules [PR #196](https://github.com/jonghee1998/ai-orchestrator/pull/196). This report is **read-only evidence accounting**, NOT an execution run or a quality gate implementation.

**Evidence snapshot:** 2026-11-20 KST, exact heads: phase1 [PR #202](https://github.com/jonghee1998/ai-orchestrator/pull/202) `1b461f8b45850f4dd15810f080fb6a835921b864`, phase2A [#203](https://github.com/jonghee1998/ai-orchestrator/pull/203) `25603260d9c92d5a61108ba90322a4b23477a2a5`, phase2B [#204](https://github.com/jonghee1998/ai-orchestrator/pull/204) `aac3f0573ee206a7d199d3fadc94dc91425fe7a8` (HEAD at audit start; MUST refresh on future runs). CI #44713586015 and #44713680643 SUCCESS, **not** code-review/security/E2E PASS. PR #196 remains unmerged draft based on integration branch, not an enforced org-wide policy.

## Original T6 eight user-visible stages (all real receipts required)

| Stage | Current evidence | Strict status | Proof needed |
|---|---|---|---|
| 1 Issue + authorized dispatch | Existing collaboration API, inert event bridge, mocked submit contract | **NOT LIVE VERIFIED** | authenticated scoped owner/PM instruction; store dispatch; exact source SHA and issuer; real GitHub event receipt |
| 2 ACK → actual provider START | #201 blocked; a Routine token alone is not a claim | **BLOCKED** | provider session ID/URL, immutable checkout SHA, signed per-run claim and lease; independent start evidence |
| 3 PR event → automated GPT PM wakeup | PR #202 dry-run `issue_comment` workflow only, not on main | **NOT ENFORCED** | approved default-branch listener and genuine receiving PM service run ID; no repeated chat handoff |
| 4 full ancestry and independent review assignment | #194 Phase B pure reference oracle still blocked on actual Sonnet start | **BLOCKED** | verified full source ancestry, every superseded/overlapping PR, evidence fingerprint and exact reviewer SHA |
| 5 trusted code/security review verdict | #202 Codex code review pass for its SHA only; #203/#204 quota blocked; no matching security receipt | **BLOCKED** | same-head actual reviewer code + separate supported security review, conflict/stale evidence invalidation |
| 6 FAIL → revise → independent re-review | Mock reservation & quiescence diagnostics; cloud session cannot independently prove process stop | **NOT LIVE VERIFIED** | single writer, safe cleanup proof, real fail/refix/re-review, root-specific default3/cap history preserved |
| 7 independent GPT PM E2E → owner approval waiting | No end-to-end provider proof or owner gate result | **NOT RUN** | CI + code/security + authenticated actual actor evidence and explicit user approval waiting (no auto-merge) |
| 8 completion and reporting | No integrated owner approval or release record | **BLOCKED** | verifiable approved integration SHA, accurate completion status and report |

## Mandatory TWO-PROVIDER capability matrix (root #146 owner requirement)

| Path | What is known | Verdict |
|---|---|---|
| Claude **developer** | Routine trigger owner reports GitHub Secret setup; existing HMAC worker has CLI and stop logic but no confirmed trusted runner host/CLI OAuth/live start | **BLOCKED** |
| Codex **developer** | Codex PR review bot is **not** developer repo/checkout proof. No independent Codex CLI developer START with private repo access shown in these PRs | **NOT VERIFIED** |
| Claude **reviewer**, different from writer | No authenticated separate-session review on exact head in this stack | **NOT VERIFIED** |
| Codex **reviewer**, different from writer | #202 exact SHA code review reported no findings; #203 and #204 review quota exceeded on newer SHAs; separate security not verified | **BLOCKED** |

**Cross-provider routing invariant:** one writer per (repo, workBranch). Both developer and reviewer roles must be independently available/authorized; never infer Codex develop access from Codex review-bot feedback, nor Claude review independence from Claude self-test. If the selected provider cannot actually start, fail closed and identify next actor. User request did not authorize automatic paid API fallback.

## Operational prerequisites and ownership

1. **GPT PM — highest priority:** reconcile PR #196 with current real code/Actions required checks and root #146 oracle, exact SHA. Existing #202/#203/#204 are stacked drafts, not live main. Root #146 historic n1–n16 and #194 limited Phase B scope stay immutable.
2. **Codex / independent security reviewer:** G5 and G6 on **every final exact SHA**. Current review quota exhausted; no credits/upgrades or pretending older SHA PASS. Avoid repeated requests while blocked.
3. **Owner + platform operator, separate approval required:** any protected default-branch workflow activation, CLI OAuth credential provisioning, protected Vercel preview ingress, environment secrets/ruleset writes, main merge and production deploy. GitHub Secret values never in comments/logs. The owner-reported `ROUTINE_FIRE_TOKEN` and `ROUTINE_FIRE_URL` belong to **cloud Routine**, not CLI OAuth.
4. **Claude/Codex developer (only after real authorized START):** independent repo access and full SHA checkout; G2 pre-code analysis; exact source tests, PR, session/cleanup proof. Cloud Routine session finish self-report cannot unlock same-branch refix; an authenticated durable subscription CLI runner has cleanup proof but requires a separately verified trusted environment.
5. **GPT PM E2E:** default-branch event receipt → legitimate assignment → actual Claude & Codex START/role capabilities → independent review → fail/revise max 3 per normal root → code/security/CI → real owner-approval WAIT, with tests E01–E18 from `docs/TEST_MATRIX.md`. At each step report owner, full SHA, evidence link, actual run ID, explicit status and next actor.

## What is NOT complete

Configured CLI/helper code and successful mock CI are **not** enforced GitHub Actions or live-verified subscription sessions. No final G3 (Claude original author), G5/G6 latest heads, G7 E2E, G8 owner gate, provider permissions check, protected ingress, cloud-session quiescence, or safe automatic three-iteration loop is demonstrated.

**Publication safety:** this report may become stale immediately after branch activity. Re-fetch all current HEADs and authenticated source evidence before publishing any new state. Status `NOT VERIFIED` must never be silently turned into PASS. No new root, issue, revision-count reset or duplicate implementation is authorized by this file.
