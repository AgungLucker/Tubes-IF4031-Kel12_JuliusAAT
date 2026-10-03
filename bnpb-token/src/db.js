import pg from 'pg';

export function createPool(connection){
    return new pg.Pool({connectionString:connection});
}

export async function initDb(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS clients (
        client_id   TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        scope       TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
        sid         UUID PRIMARY KEY,
        client_id   TEXT NOT NULL REFERENCES clients(client_id),
        scope       TEXT NOT NULL,
        current_jti UUID NOT NULL,
        revoked     BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS refresh_tokens (
        token_hash TEXT PRIMARY KEY,
        sid        UUID NOT NULL REFERENCES sessions(sid),
        used       BOOLEAN NOT NULL DEFAULT false,
        expires_at TIMESTAMPTZ NOT NULL
        );
    `)
}