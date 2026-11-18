#!/usr/bin/env node
// #198 ECC slice 1 — optional, read-only project check. ADVISORY: never a required gate.
// Codex independent review and GitHub Actions remain the authoritative gates (docs/ECC_INTEGRATION.md).
//
// Read-only contract: reads tracked files and .claude settings only. No network, no writes, no eval.
// The only subprocesses are `git ls-files -z` and `git rev-parse HEAD`. File contents are untrusted
// data: they are matched with regular expressions and never executed. Secret findings never echo values.
//
// Verdict: "fail" if any error finding; else "blocked" if any check could not run; else "pass".
// Exit codes: 0 pass, 1 fail, 2 blocked. Warnings do not change the verdict.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TOOL = "ecc-project-check";
export const TOOL_VERSION = 1;
export const LOCK_PATH = "ecc/ecc.lock.json";
const MAX_SCAN_BYTES = 1024 * 1024;
const SKIP_SCAN = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);
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

export function isAgentInstructionFile(path) {
  return path === "AGENTS.md" || path === "CLAUDE.md" || path.endsWith("/AGENTS.md") || path.endsWith("/CLAUDE.md") ||
    (path.startsWith(".claude/") && path.endsWith(".md"));
}

export function isWorkflowFile(path) {
  return /^\.github\/workflows\/[^/]+\.ya?ml$/.test(path);
}

function safeRelative(path) {
  if (typeof path !== "string" || path === "" || isAbsolute(path)) return false;
  const n = normalize(path);
  return n !== ".." && !n.startsWith(`..${sep}`) && !n.split(sep).includes("..");
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

export function checkLock(lockText, readRepoFile) {
  const findings = [];
  let lock;
  try { lock = JSON.parse(lockText); } catch { return { status: "blocked", reason: "lock-unparseable", findings }; }
  const err = (rule, detail) => findings.push({ level: "error", rule, file: LOCK_PATH, ...(detail ? { detail } : {}) });
  if (lock?.schemaVersion !== 1) return { status: "blocked", reason: "lock-schema-unsupported", findings };
  const src = lock.source ?? {};
  if (!SHA40.test(src.commit ?? "")) err("lock-source-commit-not-pinned");
  if (typeof src.repo !== "string" || !src.repo.includes("/")) err("lock-source-repo-missing");
  if (!Array.isArray(lock.adopted)) err("lock-adopted-missing");
  for (const a of Array.isArray(lock.adopted) ? lock.adopted : []) {
    if (!safeRelative(a?.path)) { err("lock-path-outside-repo", String(a?.path)); continue; }
    if (!SHA256.test(a.upstreamSha256 ?? "")) err("lock-upstream-hash-missing", a.path);
    if (!SHA256.test(a.localSha256 ?? "")) { err("lock-local-hash-missing", a.path); continue; }
    const buf = readRepoFile(a.path);
    if (buf === null) { err("adopted-file-missing", a.path); continue; }
    if (sha256(buf) !== a.localSha256) err("adopted-file-hash-mismatch", a.path);
  }
  if (!Array.isArray(lock.hooksEnabled)) err("lock-hooks-field-missing");
  else if (lock.hooksEnabled.length > 0) err("hooks-enabled-without-approval", `${lock.hooksEnabled.length} hook(s)`);
  return { status: "ran", findings };
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

function defaultGit(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

/** Run every check. `git` is injectable for tests (fault injection). Never writes. */
export function runChecks({ root, git = defaultGit } = {}) {
  const checks = [];
  const findings = [];
  const readRepoFile = (rel) => {
    const p = join(root, rel);
    try { return statSync(p).isFile() ? readFileSync(p) : null; } catch { return null; }
  };
  const record = (name, res) => {
    checks.push({ name, status: res.status, ...(res.reason ? { reason: res.reason } : {}) });
    findings.push(...res.findings);
  };

  let head = null;
  try { head = git(root, ["rev-parse", "HEAD"]).toString("utf8").trim(); if (!SHA40.test(head)) head = null; } catch { head = null; }

  let files = null;
  try {
    const raw = git(root, ["ls-files", "-z"]).toString("utf8");
    files = raw.split("\0").filter(Boolean);
  } catch { files = null; }
  if (files === null || files.length === 0) {
    // An empty or unreadable inventory is never evidence of safety.
    record("inventory", { status: "blocked", reason: files === null ? "git-ls-files-failed" : "no-tracked-files", findings: [] });
  } else {
    record("inventory", { status: "ran", findings: [] });
  }

  // Lock integrity (A7).
  const lockBuf = readRepoFile(LOCK_PATH);
  record("lock", lockBuf === null ? { status: "blocked", reason: "lock-missing", findings: [] } : checkLock(lockBuf.toString("utf8"), readRepoFile));

  // Claude settings (hooks are disabled until reviewed and approved).
  const settingsFindings = [];
  let settingsStatus = { status: "ran", findings: settingsFindings };
  for (const rel of [".claude/settings.json", ".claude/settings.local.json"]) {
    if (!existsSync(join(root, rel))) continue;
    const res = checkSettings(rel, readRepoFile(rel)?.toString("utf8") ?? "");
    settingsFindings.push(...res.findings);
    if (res.status === "blocked") settingsStatus = { status: "blocked", reason: res.reason, findings: settingsFindings };
  }
  record("claude-settings", settingsStatus);

  if (files !== null && files.length > 0) {
    const secret = [], agent = [], wf = [];
    for (const rel of files) {
      const base = rel.split("/").pop();
      const buf = readRepoFile(rel);
      if (buf === null || buf.length > MAX_SCAN_BYTES || buf.includes(0)) continue;
      const text = buf.toString("utf8");
      if (!SKIP_SCAN.has(base)) secret.push(...scanSecrets(rel, text));
      if (isAgentInstructionFile(rel)) agent.push(...scanAgentFile(rel, text));
      if (isWorkflowFile(rel)) wf.push(...scanWorkflow(rel, text));
    }
    record("secrets", { status: "ran", findings: secret });
    record("agent-instructions", { status: "ran", findings: agent });
    record("workflows", { status: "ran", findings: wf });
  } else {
    for (const name of ["secrets", "agent-instructions", "workflows"]) record(name, { status: "blocked", reason: "no-inventory", findings: [] });
  }

  const errors = findings.filter((f) => f.level === "error").length;
  const warnings = findings.filter((f) => f.level === "warn").length;
  const verdict = errors > 0 ? "fail" : checks.some((c) => c.status === "blocked") ? "blocked" : "pass";
  return { tool: TOOL, version: TOOL_VERSION, authoritative: false, head, verdict, errors, warnings, checks, findings };
}

export const exitCodeFor = (verdict) => (verdict === "pass" ? 0 : verdict === "fail" ? 1 : 2);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rootArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const root = rootArg ?? process.cwd();
  const report = runChecks({ root });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCodeFor(report.verdict);
}
