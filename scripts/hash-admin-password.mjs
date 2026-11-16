#!/usr/bin/env node
// Reads a password from stdin, never argv (process lists/history) and never echoes it.
import { randomBytes, scrypt } from "node:crypto";
if (process.stdin.isTTY) {
  console.error("Pipe the password through stdin; see docs/ADMIN_LOGIN.md. No password was read.");
  process.exit(1);
}
let password = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) {
  password += chunk;
  if (Buffer.byteLength(password, "utf8") > 1024) {
    console.error("Password must be 12–1024 UTF-8 bytes.");
    process.exit(1);
  }
}
if (Buffer.byteLength(password, "utf8") < 12 || /[\r\n\u0000]/.test(password)) {
  console.error("Password must be 12–1024 UTF-8 bytes without newline or NUL characters. Use printf, not echo.");
  process.exit(1);
}
const salt = randomBytes(16);
scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (err, key) => {
  password = "";
  if (err) { console.error("Password hashing failed."); process.exitCode = 1; return; }
  process.stdout.write(`scrypt$131072$8$1$${salt.toString("hex")}$${key.toString("hex")}\n`);
});
