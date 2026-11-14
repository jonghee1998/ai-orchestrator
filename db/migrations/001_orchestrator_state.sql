-- Orchestrator durable state (single JSON row guarded by SELECT ... FOR UPDATE).
-- Idempotent. Apply with: DATABASE_URL=... node scripts/migrate.mjs
CREATE TABLE IF NOT EXISTS orchestrator_state (id smallint PRIMARY KEY CHECK (id = 1), data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
