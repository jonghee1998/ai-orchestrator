// Production durable store: Postgres, one JSON state row guarded by SELECT ... FOR UPDATE inside a transaction.
// Gate checks + record writes are therefore atomic across processes/instances (serverless-safe).
import type { StoreData, RunStore } from "./store";

export interface SqlTx { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> }
export interface SqlPool { withTransaction<T>(fn: (tx: SqlTx) => Promise<T>): Promise<T> }

export const PG_SCHEMA = `CREATE TABLE IF NOT EXISTS orchestrator_state (id smallint PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;

export class PgRunStore implements RunStore {
  constructor(private pool: SqlPool, private empty: () => StoreData, private normalize: (raw: Partial<StoreData>) => StoreData) {}
  transact<T>(fn: (d: StoreData) => T): Promise<T> {
    return this.pool.withTransaction(async (tx) => {
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

/** Real pool backed by `pg`. Loaded lazily; connection string only from env. */
export async function createPgPool(connectionString: string): Promise<SqlPool> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 3, ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: true } });
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
