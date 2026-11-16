// Fixed-cost scrypt format. Never accepts plaintext, weak/attacker-selected costs, or default accounts.
import { scrypt, timingSafeEqual } from "node:crypto";
import type { Env } from "./session";

export const PASSWORD_PREFIX = "scrypt$131072$8$1$";
const decode = (hash: string) => {
  const parts = hash.split("$");
  if (parts.length !== 6 || !hash.startsWith(PASSWORD_PREFIX) || !/^[0-9a-f]{32}$/.test(parts[4]) || !/^[0-9a-f]{128}$/.test(parts[5])) return null;
  return { salt: Buffer.from(parts[4], "hex"), digest: Buffer.from(parts[5], "hex") };
};
export function passwordConfigured(env: Env): boolean {
  return !!env.ADMIN_USERNAME?.trim() && !!decode(env.ADMIN_PASSWORD_HASH ?? "");
}
export async function verifyPassword(username: string, password: string, env: Env): Promise<boolean> {
  const parsed = decode(env.ADMIN_PASSWORD_HASH ?? "");
  if (!parsed || !env.ADMIN_USERNAME?.trim()) return false;
  // Hash even for an unknown username, so the response does not disclose which ID exists.
  const digest = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, parsed.salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (err, key) => err ? reject(err) : resolve(key));
  });
  return timingSafeEqual(parsed.digest, digest) && username === env.ADMIN_USERNAME;
}
