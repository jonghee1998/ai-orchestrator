// Login admission control (#122). Goals, in order:
//  1. Bounded brute force: failed credential attempts are limited per client and in total.
//  2. An anonymous caller must not be able to lock the owner out with junk: only well-formed credential
//     attempts reserve budget (malformed/oversized/cross-origin requests never do), and a successful
//     login refunds its reservation, so legitimate logins do not consume the failure budget.
//  3. IPv6 clients are keyed by /64 so address rotation inside one prefix cannot exhaust the global ceiling.
//  4. Client identity is never taken from arbitrary headers. Only the platform-set header of a trusted
//     proxy is used (see clientKey); otherwise every caller shares one "unattributed" bucket.
// Each instance has its own counters; multi-instance deployments also need an upstream shared limit.
import { isIP } from "node:net";
import type { Env } from "./session";

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_ATTEMPTS = 5;          // concurrent + failed attempts per client per window
export const LOGIN_GLOBAL_ATTEMPTS = 50;  // same, across all clients (distributed brute-force ceiling)
export const LOGIN_MAX_CLIENTS = 1000;    // memory bound for the per-client map
export const UNATTRIBUTED = "unattributed";

interface Bucket { start: number; count: number }
export interface Admission { allowed: boolean; retryAfter: number; release?: (outcome: "failure" | "refund") => void }

/**
 * Trusted client IP. Vercel overwrites `x-vercel-forwarded-for` on every request, so a caller cannot choose it.
 * Honoured only when the platform is Vercel (VERCEL=1) or the owner opts in with LOGIN_TRUST_PROXY=vercel.
 * x-forwarded-for / x-real-ip / forwarded are never read: any client can send them directly.
 */
export function clientKey(h: Headers, env: Env): string {
  if (env.VERCEL !== "1" && env.LOGIN_TRUST_PROXY !== "vercel") return UNATTRIBUTED;
  const ip = (h.get("x-vercel-forwarded-for") ?? "").split(",")[0].trim();
  return ip.length <= 45 ? normalizeIp(ip) : UNATTRIBUTED;
}

/**
 * Bucket key for an IP literal. IPv4 -> dotted quad. IPv6 -> its /64 prefix (a single subscriber normally
 * controls a whole /64, so per-/128 keys let one host rotate addresses to exhaust the global ceiling).
 * Equivalent textual forms (case, "::" compression, leading zeros, zone id) map to one key, and IPv4-mapped
 * (::ffff:a.b.c.d) addresses map to the IPv4 key. Anything unparsable -> UNATTRIBUTED.
 */
export function normalizeIp(raw: string): string {
  const v = isIP(raw);
  if (v === 0) return UNATTRIBUTED;
  if (v === 4) return raw.split(".").map(Number).join(".");
  let a = raw.split("%")[0].toLowerCase();
  const tail = a.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) { // embedded IPv4 -> two hex groups
    const o = tail[1].split(".").map(Number);
    if (o.some(n => n > 255)) return UNATTRIBUTED;
    a = a.slice(0, -tail[1].length) + ((o[0] << 8) | o[1]).toString(16) + ":" + ((o[2] << 8) | o[3]).toString(16);
  }
  const [head, rest, extra] = a.split("::");
  if (extra !== undefined) return UNATTRIBUTED;
  const hs = head ? head.split(":") : [];
  const ts = rest === undefined ? [] : rest ? rest.split(":") : [];
  const fill = 8 - hs.length - ts.length;
  if (rest === undefined ? fill !== 0 : fill < 1) return UNATTRIBUTED;
  const g = [...hs, ...Array(rest === undefined ? 0 : fill).fill("0"), ...ts].map(x => parseInt(x, 16));
  if (g.length !== 8 || g.some(n => !Number.isInteger(n) || n < 0 || n > 0xffff)) return UNATTRIBUTED;
  if (g.slice(0, 5).every(n => n === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return g.slice(0, 4).map(n => n.toString(16)).join(":") + "::/64";
}

export class LoginLimiter {
  private clients = new Map<string, Bucket>();
  private all: Bucket = { start: 0, count: 0 };
  private fresh(b: Bucket | undefined, now: number): Bucket {
    return !b || now < b.start || now >= b.start + LOGIN_WINDOW_MS ? { start: now, count: 0 } : b;
  }
  /** Reserve one attempt synchronously (before async hashing) so concurrent requests are counted. */
  take(now: number, key: string = UNATTRIBUTED): Admission {
    this.all = this.fresh(this.all, now);
    if (!this.clients.has(key) && this.clients.size >= LOGIN_MAX_CLIENTS) {
      for (const [k, b] of this.clients) if (now >= b.start + LOGIN_WINDOW_MS || now < b.start) this.clients.delete(k);
      if (this.clients.size >= LOGIN_MAX_CLIENTS) key = UNATTRIBUTED; // full of live buckets: fold into the shared one
    }
    const mine = this.fresh(this.clients.get(key), now);
    this.clients.set(key, mine);
    const wait = (b: Bucket) => Math.max(1, Math.ceil((b.start + LOGIN_WINDOW_MS - now) / 1000));
    if (mine.count >= LOGIN_ATTEMPTS) return { allowed: false, retryAfter: wait(mine) };
    if (this.all.count >= LOGIN_GLOBAL_ATTEMPTS) return { allowed: false, retryAfter: wait(this.all) };
    mine.count++; this.all.count++;
    const global = this.all;
    let done = false;
    return {
      allowed: true, retryAfter: wait(mine),
      release: outcome => {
        if (done) return; done = true;
        if (outcome === "failure") return; // keep the reservation: it is a counted failed attempt
        // Refund only within the same window, so an old reservation cannot erase a newer window's count.
        if (this.clients.get(key) === mine && mine.count > 0) mine.count--;
        if (this.all === global && global.count > 0) global.count--;
      },
    };
  }
}
export const loginLimiter = new LoginLimiter();
