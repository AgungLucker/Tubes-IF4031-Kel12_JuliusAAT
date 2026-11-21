const crypto = require("crypto");

const DEFAULT_TTL_SECONDS = Number(process.env.LEASE_TTL_SECONDS || 15);
const SCHEMA_LOCK_KEY = 4031013;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ingest_lease (
    name        TEXT PRIMARY KEY,
    holder      TEXT        NOT NULL,
    epoch       BIGINT      NOT NULL,
    lease_until TIMESTAMPTZ NOT NULL,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    renewed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

// One atomic statement: acquire, renew or refuse.
const ACQUIRE_SQL = `
INSERT INTO ingest_lease (name, holder, epoch, lease_until, acquired_at, renewed_at)
VALUES ($1, $2, 1, now() + make_interval(secs => $3), now(), now())
ON CONFLICT (name) DO UPDATE SET
    holder      = EXCLUDED.holder,
    epoch       = CASE WHEN ingest_lease.holder = EXCLUDED.holder AND ingest_lease.lease_until > now()
                       THEN ingest_lease.epoch ELSE ingest_lease.epoch + 1 END,
    acquired_at = CASE WHEN ingest_lease.holder = EXCLUDED.holder AND ingest_lease.lease_until > now()
                       THEN ingest_lease.acquired_at ELSE now() END,
    lease_until = EXCLUDED.lease_until,
    renewed_at  = now()
WHERE ingest_lease.holder = EXCLUDED.holder OR ingest_lease.lease_until <= now()
RETURNING epoch, lease_until, (acquired_at = renewed_at) AS new_term`;

const RELEASE_SQL = `
UPDATE ingest_lease SET lease_until = now() - interval '1 second'
WHERE name = $1 AND holder = $2 AND epoch = $3`;

function makeHolderId() {
    const base = process.env.POD_NAME || process.env.HOSTNAME || "local";
    return `${base}.${crypto.randomBytes(3).toString("hex")}`;
}

class LeaseStore {
    constructor(pool, { holder = makeHolderId(), ttlSeconds = DEFAULT_TTL_SECONDS } = {}) {
        this.pool = pool;
        this.holder = holder;
        this.ttlSeconds = ttlSeconds;
        this.held = new Map(); // name -> epoch, so releaseAll() knows what to give back
    }

    async ensureSchema() {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
            await client.query(SCHEMA_SQL);
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    // Returns { epoch, newTerm, leaseUntil } when this holder is the leader, otherwise null.
    async acquireOrRenew(name) {
        const { rows } = await this.pool.query(ACQUIRE_SQL, [name, this.holder, this.ttlSeconds]);
        if (rows.length === 0) {
            this.held.delete(name);
            return null;
        }
        const epoch = Number(rows[0].epoch);
        this.held.set(name, epoch);
        return { epoch, newTerm: rows[0].new_term === true, leaseUntil: rows[0].lease_until };
    }

    async release(name) {
        const epoch = this.held.get(name);
        this.held.delete(name);
        if (epoch === undefined) return false;
        const { rowCount } = await this.pool.query(RELEASE_SQL, [name, this.holder, epoch]);
        return rowCount > 0;
    }

    async releaseAll() {
        const names = [...this.held.keys()];
        const results = await Promise.allSettled(names.map((n) => this.release(n)));
        return names.filter((_, i) => results[i].status === "fulfilled" && results[i].value);
    }
}

module.exports = { LeaseStore, makeHolderId, DEFAULT_TTL_SECONDS };
