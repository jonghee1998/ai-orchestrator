#!/usr/bin/env node
// #198 ECC slice 1 — optional, read-only project check. ADVISORY: never a required gate.
// Codex independent review and GitHub Actions remain the authoritative gates (docs/ECC_INTEGRATION.md).
//
// Read-only contract: no network, no writes, no eval. Subprocesses are limited to `git rev-parse HEAD`,
// `git ls-files -s -z` and `git --no-optional-locks status --porcelain -z` (no index refresh write).
// Every file read goes through safeRead(): repository containment on the resolved path (any symlink
// component is rejected), regular-file check and size check BEFORE allocation, bounded read.
// File contents are untrusted data: regex-matched only. Every string in the report is redacted
// against SECRET_RULES before it is returned, so no repository-controlled field can echo a credential.
//
// Verdict: "fail" if any error finding; else "blocked" if any check could not run or a required
// target could not be inspected; else "pass". Exit codes: 0 pass, 1 fail, 2 blocked.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL = "ecc-project-check";
export const TOOL_VERSION = 2;
export const LOCK_PATH = "ecc/ecc.lock.json";
export const MAX_SCAN_BYTES = 1024 * 1024;
const MAX_REPORT_STRING = 300;
// Policy exclusions (explicit and reported): generated dependency lockfiles are not secret-scanned.
const POLICY_SKIP_SECRETS = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
const SETTINGS_PATHS = [".claude/settings.json", ".claude/settings.local.json"];
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

// High-confidence secret shapes only (low false-positive rate). Values are never reported.
export const SECRET_RULES = [
  ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/],
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{40,}/],
  ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
];
const SECRET_RULES_GLOBAL = SECRET_RULES.map(([rule, re]) => [rule, new RegExp(re.source, `${re.flags}g`)]);

// Risky directives inside files an agent reads as instructions.
export const AGENT_RULES = [
  ["prompt-override", /\bignore (?:all )?(?:previous|prior|above|earlier) instructions\b/i],
  ["pipe-to-shell", /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i],
  ["skip-permissions-flag", /--dangerously-skip-permissions/],
  ["bypass-permissions-mode", /\bbypassPermissions\b/],
];

const FIRST_PARTY_ACTION_OWNERS = new Set(["actions", "github"]);
const UNTRUSTED_EXPR =
  /\$\{\{\s*github\.(?:head_ref|event\.[A-Za-z0-9_.]*\.(?:title|body|message|head_ref|label|name|email)|event\.pull_request\.head\.ref)\s*\}\}/;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Replace every secret-shaped substring and cap length. Applied to every string in the report. */
export function redact(value) {
  let s = String(value);
  for (const [rule, re] of SECRET_RULES_GLOBAL) s = s.replace(re, `[REDACTED:${rule}]`);
  return s.length > MAX_REPORT_STRING ? `${s.slice(0, MAX_REPORT_STRING)}…[truncated]` : s;
}

function redactDeep(v) {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

export function isAgentInstructionFile(path) {
  return path === "AGENTS.md" || path === "CLAUDE.md" || path.endsWith("/AGENTS.md") || path.endsWith("/CLAUDE.md") ||
    (path.startsWith(".claude/") && path.endsWith(".md"));
}

export function isWorkflowFile(path) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

function lexicallySafe(path) {
  if (typeof path !== "string" || path === "" || path.includes("\0") || isAbsolute(path)) return false;
  const n = normalize(path);
  return n !== ".." && !n.startsWith(`..${sep}`) && !n.split(sep).includes("..");
}

/**
 * Read one repository file without leaving the repository and without unbounded allocation.
 * `realRoot` must already be realpath()-resolved. Returns {ok:true, buf} or {ok:false, kind[, size]}
 * where kind is missing | symlink | outside | not-file | too-large | unreadable.
 */
export function safeRead(realRoot, rel, { maxBytes = MAX_SCAN_BYTES, io = nodeFs } = {}) {
  if (!lexicallySafe(rel)) return { ok: false, kind: "outside" };
  const full = resolve(realRoot, rel);
  if (!full.startsWith(realRoot + sep)) return { ok: false, kind: "outside" };
  let lst;
  try { lst = io.lstatSync(full); } catch (e) {
    return { ok: false, kind: e?.code === "ENOENT" || e?.code === "ENOTDIR" ? "missing" : "unreadable" };
  }
  if (lst.isSymbolicLink()) return { ok: false, kind: "symlink" };
  let real;
  try { real = io.realpathSync(full); } catch { return { ok: false, kind: "unreadable" }; }
  // A different resolved path means some parent component is a symlink: reject either way.
  if (real !== full) return { ok: false, kind: real.startsWith(realRoot + sep) ? "symlink" : "outside" };
  if (!lst.isFile()) return { ok: false, kind: "not-file" };
  let fd;
  try { fd = io.openSync(full, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW ?? 0)); } catch (e) {
    return { ok: false, kind: e?.code === "ELOOP" ? "symlink" : "unreadable" };
  }
  try {
    const st = io.fstatSync(fd);
    if (!st.isFile()) return { ok: false, kind: "not-file" };
    if (st.size > maxBytes) return { ok: false, kind: "too-large", size: st.size };
    // Bounded: at most maxBytes + 1 bytes are ever allocated or read (the +1 detects growth).
    const buf = Buffer.alloc(Math.min(st.size, maxBytes) + 1);
    let n = 0;
    while (n < buf.length) {
      const r = io.readSync(fd, buf, n, buf.length - n, n);
      if (r === 0) break;
      n += r;
    }
    if (n > maxBytes) return { ok: false, kind: "too-large", size: n };
    return { ok: true, buf: buf.subarray(0, n) };
  } catch {
    return { ok: false, kind: "unreadable" };
  } finally {
    try { io.closeSync(fd); } catch { /* ignore */ }
  }
}

export function scanSecrets(path, text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const [rule, re] of SECRET_RULES) {
      if (re.test(line)) { out.push({ level: "error", rule, file: path, line: i + 1 }); break; }
    }
  });
  return out;
}

export function scanAgentFile(path, text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const [rule, re] of AGENT_RULES) if (re.test(line)) out.push({ level: "error", rule, file: path, line: i + 1 });
  });
  return out;
}

export function scanWorkflow(path, text) {
  const out = [];
  const lines = text.split("\n");
  const add = (level, rule, line, detail) => out.push({ level, rule, file: path, line, ...(detail ? { detail } : {}) });

  if (!lines.some((l) => /^permissions\s*:/.test(l))) add("error", "missing-top-level-permissions", 1);
  lines.forEach((l, i) => { if (/^\s*permissions\s*:\s*write-all\b/.test(l)) add("error", "write-all-permissions", i + 1); });

  const prTarget = lines.some((l) => /^\s*(?:-\s*)?pull_request_target\b/.test(l) || /^on\s*:.*\bpull_request_target\b/.test(l));
  if (prTarget) {
    lines.forEach((l, i) => {
      if (/github\.event\.pull_request\.head\.(?:sha|ref)|refs\/pull\//.test(l)) add("error", "pull-request-target-head-checkout", i + 1);
    });
  }

  // run: blocks (inline or block scalar) must not interpolate attacker-controlled event fields.
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s*)?run\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    if (UNTRUSTED_EXPR.test(m[2])) add("error", "run-script-injection", i + 1);
    if (/^[|>]/.test(m[2].trim())) {
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
        if (UNTRUSTED_EXPR.test(l)) add("error", "run-script-injection", j + 1);
      }
    }
  }

  lines.forEach((l, i) => {
    const m = /^\s*(?:-\s*)?uses\s*:\s*["']?([^\s"'#]+)/.exec(l);
    if (!m) return;
    const ref = m[1];
    if (ref.startsWith("./") || ref.startsWith("docker://")) return;
    const [action, version = ""] = ref.split("@");
    const owner = action.split("/")[0];
    if (FIRST_PARTY_ACTION_OWNERS.has(owner)) return;
    if (!SHA40.test(version)) add("warn", "third-party-action-not-sha-pinned", i + 1, action);
  });
  return out;
}

const NOT_IN_REPO = new Set(["symlink", "outside", "not-file"]);

/** `read(rel)` returns a safeRead() result. Files the lock pins must be regular files inside the repo. */
export function checkLock(lockText, read) {
  const findings = [];
  let lock;
  try { lock = JSON.parse(lockText); } catch { return { status: "blocked", reason: "lock-unparseable", findings }; }
  const err = (rule, detail) => findings.push({ level: "error", rule, file: LOCK_PATH, ...(detail ? { detail: String(detail) } : {}) });
  if (lock?.schemaVersion !== 1) return { status: "blocked", reason: "lock-schema-unsupported", findings };
  const src = lock.source ?? {};
  if (!SHA40.test(src.commit ?? "")) err("lock-source-commit-not-pinned");
  if (typeof src.repo !== "string" || !src.repo.includes("/")) err("lock-source-repo-missing");
  if (!Array.isArray(lock.adopted)) err("lock-adopted-missing");
  let blockedReason = null;
  for (const a of Array.isArray(lock.adopted) ? lock.adopted : []) {
    if (!lexicallySafe(a?.path)) { err("lock-path-outside-repo", a?.path); continue; }
    if (!SHA256.test(a.upstreamSha256 ?? "")) err("lock-upstream-hash-missing", a.path);
    if (!SHA256.test(a.localSha256 ?? "")) { err("lock-local-hash-missing", a.path); continue; }
    const r = read(a.path);
    if (!r.ok) {
      if (r.kind === "missing") err("adopted-file-missing", a.path);
      else if (NOT_IN_REPO.has(r.kind)) err("adopted-file-not-regular-in-repo", `${a.path} (${r.kind})`);
      else blockedReason = `adopted-file-${r.kind}`;
      continue;
    }
    if (sha256(r.buf) !== a.localSha256) err("adopted-file-hash-mismatch", a.path);
  }
  if (!Array.isArray(lock.hooksEnabled)) err("lock-hooks-field-missing");
  else if (lock.hooksEnabled.length > 0) err("hooks-enabled-without-approval", `${lock.hooksEnabled.length} hook(s)`);
  return blockedReason ? { status: "blocked", reason: blockedReason, findings } : { status: "ran", findings };
}

export function checkSettings(path, text) {
  let s;
  try { s = JSON.parse(text); } catch { return { status: "blocked", reason: `settings-unparseable:${path}`, findings: [] }; }
  const findings = [];
  if (s && typeof s === "object" && s.hooks && Object.keys(s.hooks).length > 0) {
    findings.push({ level: "error", rule: "settings-hooks-not-reviewed", file: path });
  }
  if (s?.permissions?.defaultMode === "bypassPermissions") findings.push({ level: "error", rule: "settings-bypass-permissions", file: path });
  const allow = Array.isArray(s?.permissions?.allow) ? s.permissions.allow : [];
  for (const rule of allow) {
    if (rule === "*" || rule === "Bash" || rule === "Bash(*)") findings.push({ level: "warn", rule: "settings-broad-allow", file: path, detail: rule });
  }
  return { status: "ran", findings };
}

/** Parse `git ls-files -s -z`: "<mode> <sha> <stage>\t<path>\0". */
export function parseLsFiles(raw) {
  const out = [];
  for (const rec of raw.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) throw new Error("malformed ls-files record");
    out.push({ mode: rec.slice(0, rec.indexOf(" ")), path: rec.slice(tab + 1) });
  }
  return out;
}

/** Parse `git status --porcelain -z`. Returns {entries, deleted:Set}. */
export function parseStatus(raw) {
  const toks = raw.split("\0");
  const deleted = new Set();
  let entries = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!t) continue;
    if (t.length < 4 || t[2] !== " ") throw new Error("malformed status record");
    entries++;
    const xy = t.slice(0, 2);
    if (xy.includes("D")) deleted.add(t.slice(3));
    if (xy[0] === "R" || xy[0] === "C") i++; // rename/copy: the next token is the original path
  }
  return { entries, deleted };
}

function defaultGit(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Run every check. `git`, `io` and `maxBytes` are injectable for tests (fault injection, read metering).
 * Never writes. The returned report is fully redacted.
 */
export function runChecks({ root, git = defaultGit, io = nodeFs, maxBytes = MAX_SCAN_BYTES } = {}) {
  const checks = [];
  const findings = [];
  const coverage = { scanned: 0, excluded: [], missing: [] };
  const record = (name, res) => {
    checks.push({ name, status: res.status, ...(res.reason ? { reason: res.reason } : {}) });
    findings.push(...res.findings);
  };
  const finish = (head, worktree) => {
    const errors = findings.filter((f) => f.level === "error").length;
    const warnings = findings.filter((f) => f.level === "warn").length;
    const verdict = errors > 0 ? "fail" : checks.some((c) => c.status === "blocked") ? "blocked" : "pass";
    return redactDeep({ tool: TOOL, version: TOOL_VERSION, authoritative: false, head, worktree, verdict, errors, warnings, checks, coverage, findings });
  };

  let realRoot;
  try { realRoot = io.realpathSync(resolve(root)); } catch {
    record("root", { status: "blocked", reason: "root-unresolvable", findings: [] });
    return finish(null, null);
  }
  const read = (rel) => safeRead(realRoot, rel, { maxBytes, io });

  // HEAD and input scope (A8). A report without a verified HEAD is never a pass.
  let head = null;
  try { const h = git(realRoot, ["rev-parse", "HEAD"]).toString("utf8").trim(); head = SHA40.test(h) ? h : null; } catch { head = null; }
  record("head", head ? { status: "ran", findings: [] } : { status: "blocked", reason: "head-unverified", findings: [] });

  let worktree = null;
  let deleted = new Set();
  try {
    const st = parseStatus(git(realRoot, ["--no-optional-locks", "status", "--porcelain", "-z"]).toString("utf8"));
    deleted = st.deleted;
    // "commit": inputs are exactly HEAD's tracked files. "working-tree": results describe local modifications.
    worktree = { scope: st.entries === 0 ? "commit" : "working-tree", changedEntries: st.entries };
    record("worktree", { status: "ran", findings: [] });
  } catch {
    record("worktree", { status: "blocked", reason: "worktree-status-failed", findings: [] });
  }

  let files = null;
  try { files = parseLsFiles(git(realRoot, ["ls-files", "-s", "-z"]).toString("utf8")); } catch { files = null; }
  if (files === null || files.length === 0) {
    // An empty or unreadable inventory is never evidence of safety.
    record("inventory", { status: "blocked", reason: files === null ? "git-ls-files-failed" : "no-tracked-files", findings: [] });
  } else {
    record("inventory", { status: "ran", findings: [] });
  }

  // Lock integrity (A7). The lock itself must be a regular file inside the repository.
  const lockRead = read(LOCK_PATH);
  if (lockRead.ok) record("lock", checkLock(lockRead.buf.toString("utf8"), read));
  else if (lockRead.kind === "missing") record("lock", { status: "blocked", reason: "lock-missing", findings: [] });
  else if (NOT_IN_REPO.has(lockRead.kind)) record("lock", { status: "ran", findings: [{ level: "error", rule: "lock-not-regular-in-repo", file: LOCK_PATH, detail: lockRead.kind }] });
  else record("lock", { status: "blocked", reason: `lock-${lockRead.kind}`, findings: [] });

  // Claude settings (hooks stay disabled until reviewed and approved). Absent settings are fine.
  const sFindings = [];
  let sBlocked = null;
  for (const rel of SETTINGS_PATHS) {
    const r = read(rel);
    if (r.ok) {
      const res = checkSettings(rel, r.buf.toString("utf8"));
      sFindings.push(...res.findings);
      if (res.status === "blocked") sBlocked = res.reason;
    } else if (r.kind === "missing") {
      continue;
    } else if (NOT_IN_REPO.has(r.kind)) {
      sFindings.push({ level: "error", rule: "settings-not-regular-in-repo", file: rel, detail: r.kind });
    } else {
      sBlocked = `settings-${r.kind}:${rel}`;
    }
  }
  record("claude-settings", sBlocked ? { status: "blocked", reason: sBlocked, findings: sFindings } : { status: "ran", findings: sFindings });

  if (files !== null && files.length > 0) {
    const secret = [], agent = [], wf = [];
    const incomplete = { secrets: 0, agent: 0, workflows: 0 };
    for (const { mode, path: rel } of files) {
      const r = read(rel);
      if (!r.ok) {
        if (mode === "120000" && r.kind === "symlink") { coverage.excluded.push({ file: rel, reason: "tracked-symlink-not-followed" }); continue; }
        if (r.kind === "missing" && deleted.has(rel)) { coverage.excluded.push({ file: rel, reason: "deleted-in-working-tree" }); continue; }
        // A required target that could not be inspected: never silently skipped.
        coverage.missing.push({ file: rel, reason: r.kind, ...(r.size !== undefined ? { size: r.size } : {}) });
        incomplete.secrets++;
        if (isAgentInstructionFile(rel)) incomplete.agent++;
        if (isWorkflowFile(rel)) incomplete.workflows++;
        continue;
      }
      if (r.buf.includes(0)) { coverage.excluded.push({ file: rel, reason: "binary" }); continue; }
      coverage.scanned++;
      const text = r.buf.toString("utf8");
      if (POLICY_SKIP_SECRETS.has(rel.split("/").pop())) coverage.excluded.push({ file: rel, reason: "lockfile-not-secret-scanned" });
      else secret.push(...scanSecrets(rel, text));
      if (isAgentInstructionFile(rel)) agent.push(...scanAgentFile(rel, text));
      if (isWorkflowFile(rel)) wf.push(...scanWorkflow(rel, text));
    }
    const st = (n, f) => (n > 0 ? { status: "blocked", reason: `incomplete-coverage:${n}`, findings: f } : { status: "ran", findings: f });
    record("secrets", st(incomplete.secrets, secret));
    record("agent-instructions", st(incomplete.agent, agent));
    record("workflows", st(incomplete.workflows, wf));
  } else {
    for (const name of ["secrets", "agent-instructions", "workflows"]) record(name, { status: "blocked", reason: "no-inventory", findings: [] });
  }

  return finish(head, worktree);
}

export const exitCodeFor = (verdict) => (verdict === "pass" ? 0 : verdict === "fail" ? 1 : 2);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rootArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const report = runChecks({ root: rootArg ?? process.cwd() });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCodeFor(report.verdict);
}
