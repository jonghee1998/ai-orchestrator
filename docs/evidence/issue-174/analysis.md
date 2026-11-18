# Issue #174 — pre-code analysis (scenario matrix + impact map)

Source: PR173 `fd94f4dc06fd91cc2e863ace702d915bb4e15972`. Written before the first code commit on this branch.

## Readers / producers / trust boundaries
| Item | Producer | Reader | Boundary |
|---|---|---|---|
| Codex code+security verdict | trusted bot `codex-review-state:v1` | lifecycle `reviewEvidence`, gate `codex_review` (previously two copies) | login+id+type |
| Correction n / revise:N | trusted PM markers, derived chain record | `resolveRootCorrections`, lifecycle-run | trusted PM, exact PR+SHA |
| dev-analysis / self-test / pm-* receipts | developer / PM comments & bodies | `evaluateGate` | trusted PM or PR author id; edits visible via `updated_at` |
| Check enforcement | workflow (base branch) | `scripts/gate/check.mjs` → commit status | PR code never executed |

## Scenario matrix
1 verdict: opposed code flags, opposed security flags, multi-marker, malformed, security missing, stale SHA, order reversal, duplicates, forged author → both entrypoints BLOCKED (gate174.test.mjs #174-1).
2 request: before n8 (count+1), after own n8 with proven ancestry, other-chain n1..n7, unproven ancestry, other PR claiming n8, conflicting marker, replay → #174-2.
3 timing: edited-before, edited-after, absent/garbled updated_at, equal timestamp, forged writer, wrong issue, malformed marker, unknown commit time → #174-3.
4 CI: omission of each receipt, tampered edit/stale sha/forged PM, fetch failure, unknown stage, stage split → #174-4.

## Extra related defect found
The root146 ceiling (7) made `n=8` unrecordable, so this correction's own marker would fail closed (`root_correction_n_out_of_range`). Raised to 8 for root 146 only per #174 owner authorization; PM must persist a `max=8` limit marker.
