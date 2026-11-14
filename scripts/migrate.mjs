// Applies db/migrations/*.sql in order. Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs
// Connection string comes from env only; never printed.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is not set"); process.exit(2); }
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
let host = ""; try { host = new URL(url).hostname.toLowerCase(); } catch {}
const bundled = /\.supabase\.(com|co)$/.test(host) ? (await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "certs", "supabase-prod-ca-2021.crt"), "utf8")).trim() : undefined;
const caPem = process.env.DATABASE_SSL_CA?.replace(/\\n/g, "\n").trim() || bundled;
const client = new pg.Client({ connectionString: url, ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: true, ...(caPem ? { ca: caPem } : {}) } });
await client.connect();
try {
  for (const f of files) { await client.query(await readFile(path.join(dir, f), "utf8")); console.log("applied", f); }
} finally { await client.end(); }
