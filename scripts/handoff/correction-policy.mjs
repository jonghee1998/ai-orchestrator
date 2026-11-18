// Issue #184 — SINGLE authority for the root-correction round policy. Every consumer (root-corrections resolver, lifecycle planner,
// lifecycle-run, gate) imports these; there is no second copy to drift (P2 of #183: resolver accepted 12 while planner hardcoded 11).
export const MAX_CORRECTIONS = 3; // default for every root
export const CORRECTION_CEILING = 5; // hard ceiling no override can exceed (except the exact owner-approved exception below)
// Standing owner authorization (root #146 comment 6969965595): root #146 ONLY may advance 12 -> 13 for the #184 ordinal. n1..n12 history is
// preserved; no 14th without PM exact-FAIL + authorization; no global raise; other roots keep default 3 / ceiling 5.
export const ROOT_CEILING_EXCEPTIONS = Object.freeze({ 146: 13 });
export const ceilingFor = (root) => ROOT_CEILING_EXCEPTIONS[root] ?? CORRECTION_CEILING;
