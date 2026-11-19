const fs = require("fs");
const path = require("path");
const {shards} = require("./shards");

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.join(__dirname, "..", "..", "migrations");
const LOCK_KEY = 4031012; // konstanta bebas, sama di semua instance
const RETRY_MS = Number(process.env.MIGRATION_RETRY_MS || 15000);

function loadMigrations() {
    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => /^\d+_.+\.sql$/.test(f))
        .sort()
        .map((file) => ({
            version: file.replace(/\.sql$/, ""),
            sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"),
        }));
}

async function migrateShard(shard, migrations) {
    const client = await shard.pool.connect();
    try {
        await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            version    TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        const { rows } = await client.query("SELECT version FROM schema_migrations");
        const applied = new Set(rows.map((r) => r.version));

        const done = [];
        for (const m of migrations) {
            if (applied.has(m.version)) continue;
            await client.query("BEGIN");
            try {
                await client.query(m.sql);
                await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [m.version]);
                await client.query("COMMIT");
                done.push(m.version);
            } catch (err) {
                await client.query("ROLLBACK");
                throw new Error(`${m.version}: ${err.message}`);
            }
        }
        return done;
    } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
        client.release();
    }
}

async function migrateAll(targets = shards) {
    const migrations = loadMigrations();
    const results = await Promise.allSettled(targets.map((s) => migrateShard(s, migrations)));
    const ok = [];
    const failed = [];
    results.forEach((r, i) => {
        const name = targets[i].name;
        if (r.status === "fulfilled") {
            ok.push(name);
            console.log(`[migrate] ${name}: ${r.value.length ? "diterapkan " + r.value.join(", ") : "sudah terbaru"}`);
        } else {
            failed.push({ shard: name, error: r.reason.message });
            console.error(`[migrate] ${name}: GAGAL - ${r.reason.message}`);
        }
    });
    return { ok, failed };
}

function startMigrationLoop() {
    let pending = shards;
    const tick = async () => {
        const { failed } = await migrateAll(pending);
        pending = shards.filter((s) => failed.some((f) => f.shard === s.name));
        if (pending.length) setTimeout(tick, RETRY_MS).unref();
    };
    return tick();
}

module.exports = { migrateAll, startMigrationLoop };

if (require.main === module) {
    migrateAll()
        .then(({ failed }) => process.exit(failed.length ? 1 : 0))
        .catch((err) => {
            console.error(err);
            process.exit(1);
        });
}
