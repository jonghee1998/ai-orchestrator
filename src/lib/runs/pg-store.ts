// Production durable store: Postgres, one JSON state row guarded by SELECT ... FOR UPDATE inside a transaction.
// Gate checks + record writes are therefore atomic across processes/instances (serverless-safe).
import type { StoreData, RunStore } from "./store";

export interface SqlTx { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
import { SUPABASE_ROOT_CA_2021, isSupabaseHost } from "./supabase-ca";
export interface SqlPool { withTransaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T> }

// Must match db/migrations/001_orchestrator_state.sql (checked by pg-store.integration.test). Kept as a
// self-healing fallback; the supported path is `node scripts/migrate.mjs` before first deploy.
export const PG_SCHEMA = `CREATE TABLE IF NOT EXISTS orchestrator_state (id smallint PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;

export class PgRunStore implements RunStore {
  constructor(private pool: SqlPool, private empty: () => StoreData, private normalize: (raw: Partial<StoreData>) => StoreData) {}
  transact<T>(fn: (d: StoreData) => T): Promise<T> {
    return this.pool.withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(727001)"); // CREATE TABLE IF NOT EXISTS is not concurrency-safe on its own
      await tx.query(PG_SCHEMA);
      await tx.query("INSERT INTO orchestrator_state (id, data) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING", [JSON.stringify(this.empty())]);
      const { rows } = await tx.query("SELECT data FROM orchestrator_state WHERE id = 1 FOR UPDATE");
      const d = this.normalize(rows[0].data as Partial<StoreData>);
      const out = fn(d);
      await tx.query("UPDATE orchestrator_state SET data = $1::jsonb, updated_at = now() WHERE id = 1", [JSON.stringify(d)]);
      return out;
    });
  }
  read(): Promise<StoreData> { return this.transact((d) => structuredClone(d)); }
}

/** Pure: builds pg connection options. TLS verification is ALWAYS on unless DATABASE_SSL=disable (local tests).
 *  DATABASE_SSL_CA (PEM) adds a provider CA (e.g. Supabase pooler) while keeping rejectUnauthorized: true.
 *  sslmode/sslrootcert query params are stripped so they cannot silently override the explicit ssl option. */
export function buildPgConfig(connectionString: string, env: Readonly<Record<string, string | undefined>> = process.env) {
  let cs = connectionString;
  try { const u = new URL(connectionString); for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) u.searchParams.delete(k); cs = u.toString(); } catch { /* let pg report an invalid URL */ }
  let host = ""; try { host = new URL(connectionString).hostname; } catch { /* ignore */ }
  // Explicit DATABASE_SSL_CA wins; otherwise bundled official Supabase CA for Supabase hosts only. Verification stays on.
  const ca = env.DATABASE_SSL_CA?.replace(/\\n/g, "\n").trim() || (isSupabaseHost(host) ? SUPABASE_ROOT_CA_2021 : undefined);
  const ssl = env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: true as const, ...(ca ? { ca } : {}) };
  return { connectionString: cs, max: 3, connectionTimeoutMillis: 8000, ssl };
}

/** Real pool backed by `pg`. Loaded lazily; connection string only from env. */
export async function createPgPool(connectionString: string): Promise<SqlPool> {
  const { Pool } = await import("pg");
  const pool = new Pool(buildPgConfig(connectionString));
  pool.on("error", () => undefined); // idle-client errors must not crash the process
  return {
    async withTransaction(fn) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const out = await fn({ query: (s, p) => c.query(s, p as unknown[]) as Promise<{ rows: Record<string, unknown>[] }> });
        await c.query("COMMIT");
        return out;
      } catch (e) { await c.query("ROLLBACK").catch(() => undefined); throw e; } finally { c.release(); }
    },
  };
}
