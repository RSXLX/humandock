import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Sql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS hd_write_lock (id integer PRIMARY KEY);
INSERT INTO hd_write_lock(id) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS hd_tasks (
  id uuid PRIMARY KEY, org_id text NOT NULL, buyer_id text NOT NULL,
  reviewer_id text NOT NULL, version integer NOT NULL, data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hd_tasks_org_idx ON hd_tasks(org_id);
CREATE INDEX IF NOT EXISTS hd_tasks_reviewer_idx ON hd_tasks(reviewer_id);
CREATE TABLE IF NOT EXISTS hd_sessions (
  token_hash text PRIMARY KEY, data jsonb NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS hd_idempotency (
  actor_id text NOT NULL, route text NOT NULL, key text NOT NULL,
  body_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz DEFAULT now(),
  PRIMARY KEY(actor_id, route, key)
);
CREATE TABLE IF NOT EXISTS hd_exports (
  id uuid PRIMARY KEY, org_id text NOT NULL, task_id uuid REFERENCES hd_tasks(id),
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hd_ledger (
  id uuid PRIMARY KEY, task_id uuid REFERENCES hd_tasks(id), account_id text NOT NULL,
  bucket text NOT NULL CHECK (bucket IN ('escrow','claimable','withdrawn')),
  entry_type text NOT NULL, amount_atoms numeric(78,0) NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS hd_ledger_account_idx ON hd_ledger(account_id);
CREATE TABLE IF NOT EXISTS hd_audit (
  id uuid PRIMARY KEY, actor_id text NOT NULL, action text NOT NULL,
  resource_id text NOT NULL, created_at timestamptz NOT NULL
);
`;

export class Database implements Sql {
  readonly kind: 'pglite' | 'postgres';
  private embedded?: PGlite;
  private pool?: pg.Pool;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private options: { url?: string; dataDir?: string } = {}) { this.kind = options.url ? 'postgres' : 'pglite'; }
  async start() {
    if (this.options.url) { this.pool = new pg.Pool({ connectionString: this.options.url, max: 8 }); await this.pool.query(SCHEMA); }
    else {
      const dir = this.options.dataDir ?? '.data/pglite';
      if (dir !== 'memory://') await mkdir(dir, { recursive: true, mode: 0o700 });
      this.embedded = new PGlite(dir === 'memory://' ? undefined : dir);
      await this.embedded.exec(SCHEMA);
    }
  }
  async query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{rows:T[]}> {
    if (this.pool) return this.pool.query<T>(sql, params);
    if (!this.embedded) throw new Error('Database is not started');
    return this.embedded.query<T>(sql, params);
  }
  async transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T> {
    const execute = async () => {
      if (this.pool) {
        const client = await this.pool.connect();
        try {
          await client.query('BEGIN'); await client.query('SELECT id FROM hd_write_lock WHERE id = 1 FOR UPDATE');
          const result = await work(client); await client.query('COMMIT'); return result;
        } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
      }
      if (!this.embedded) throw new Error('Database is not started');
      return this.embedded.transaction(async tx => work(tx));
    };
    const pending = this.writes.then(execute, execute);
    this.writes = pending.catch(() => undefined);
    return pending;
  }
  async close() { await this.writes; await this.embedded?.close(); await this.pool?.end(); }
}
