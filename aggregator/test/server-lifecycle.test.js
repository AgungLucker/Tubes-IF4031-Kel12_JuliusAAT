// The real server process: readiness, forced-unhealthy, and graceful shutdown.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Pool } = require("pg");
const { startTempPostgres, postgresAvailable } = require("./helpers/tempPostgres");

const skip = postgresAvailable() ? false : "PostgreSQL (initdb/pg_ctl) not found; set PG_BIN";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..");
const TTL_S = 3;
const DRAIN_MS = 1500;

const freePort = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

function startServer(name, port, env) {
    const proc = spawn(process.execPath, ["src/server.js"], {
        cwd: ROOT, stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
            ...process.env, PORT: String(port), POD_NAME: name, AUDIT_TOKEN: "secret",
            POLL_INTERVAL_MS: "500", LEASE_TTL_SECONDS: String(TTL_S), SHUTDOWN_DRAIN_MS: String(DRAIN_MS),
            SHARD_CHECK_MS: "500", SHARD_COUNT: "1",
            BMKG_BASE_URL: "http://127.0.0.1:9", PVMBG_BASE_URL: "http://127.0.0.1:9", SATELLITE_PROCESSOR_URL: "http://127.0.0.1:9",
            RABBITMQ_URL: "amqp://127.0.0.1:9", SOURCE_TIMEOUT_MS: "500",
            ...env,
        },
    });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    const exited = new Promise((r) => proc.on("exit", (code) => r({ code, at: Date.now() })));
    const call = async (p, opt = {}) => {
        try {
            const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...opt, signal: AbortSignal.timeout(3000) });
            return { status: res.status, body: await res.json().catch(() => null) };
        } catch (e) {
            return { status: "ERR", error: e.message };
        }
    };
    return { name, proc, port, call, exited, output: () => out };
}

async function waitFor(fn, { timeoutMs = 25_000, every = 250, label } = {}) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await sleep(every);
    }
    throw new Error(`timeout waiting for ${label}`);
}

test("readiness, forced unready, and graceful shutdown of the real server", { skip, timeout: 120_000 }, async (t) => {
    const pg = await startTempPostgres(["ingest", "shard1"]);
    const ingest = new Pool({ connectionString: pg.url("ingest") });
    await ingest.query(fs.readFileSync(path.join(ROOT, "../k8s/databases/ingest-init.sql"), "utf8"));
    const env = { INGEST_DATABASE_URL: pg.url("ingest"), SHARD_1_URI: pg.url("shard1") };

    const a = startServer("agg-A", await freePort(), env);
    const b = startServer("agg-B", await freePort(), env);
    const servers = [a, b];
    const diag = () => servers.map((s) => `--- ${s.name} output ---\n${s.output().slice(-1500)}`).join("\n");

    try {
        // ---- readiness
        await waitFor(async () => (await a.call("/health/ready")).status === 200, { label: "A ready" })
            .catch((e) => { throw new Error(`${e.message}\n${diag()}`); });
        await waitFor(async () => (await b.call("/health/ready")).status === 200, { label: "B ready" });

        const live = await a.call("/health");
        const ready = await a.call("/health/ready");
        assert.equal(live.status, 200);
        assert.equal(ready.status, 200);
        assert.deepEqual([ready.body.shardsUp, ready.body.shardsTotal, ready.body.reasons], [1, 1, []]);

        // ---- one leader per lease, held by one of the two servers
        const holders = async () => (await ingest.query("SELECT name, holder, epoch, (lease_until > now()) AS live FROM ingest_lease ORDER BY name")).rows;
        await waitFor(async () => (await holders()).length === 5, { label: "5 leases" });
        const leases = await holders();
        assert.deepEqual(leases.map((l) => l.name), ["BMKG", "OUTBOX", "PVMBG", "REPLAY", "SATELIT"]);
        assert.ok(leases.every((l) => l.live && /^agg-[AB]\./.test(l.holder)));

        // ---- forced unhealthy: the load balancer must stop routing here, liveness must NOT fail
        assert.equal((await a.call("/health/force-unready", { method: "POST" })).status, 401, "no token");
        assert.equal((await a.call("/health/force-unready", { method: "POST", headers: { Authorization: "Bearer wrong" } })).status, 401, "bad token");
        assert.equal((await a.call("/health/force-unready", { method: "POST", headers: { Authorization: "Bearer secret" } })).status, 200);
        const forced = await a.call("/health/ready");
        assert.equal(forced.status, 503);
        assert.deepEqual(forced.body.reasons, ["forced_unready"]);
        assert.equal((await a.call("/health")).status, 200, "liveness unaffected, so the pod is not restarted");
        assert.equal((await b.call("/health/ready")).status, 200, "the other instance is untouched");
        assert.equal((await a.call("/health/force-ready", { method: "POST", headers: { Authorization: "Bearer secret" } })).status, 200);
        assert.equal((await a.call("/health/ready")).status, 200);

        // ---- graceful shutdown of the BMKG leader
        const bmkg = (await holders()).find((l) => l.name === "BMKG");
        const leader = bmkg.holder.startsWith("agg-A") ? a : b;
        const other = leader === a ? b : a;
        const startedAt = Date.now();
        leader.proc.send("shutdown");

        await sleep(300);
        const draining = await leader.call("/health/ready");
        assert.equal(draining.status, 503, "stops being ready at once");
        assert.deepEqual(draining.body.reasons, ["draining"]);
        const stillServing = await leader.call("/hazard-events");
        assert.equal(stillServing.status, 200, "keeps serving while the endpoint removal spreads (no failed request)");

        // the other instance takes the lease because it was RELEASED, not because it ran out
        const successor = await waitFor(async () => {
            const row = (await holders()).find((l) => l.name === "BMKG");
            return row.holder.startsWith(other.name) ? row : null;
        }, { timeoutMs: 10_000, every: 100, label: "other instance takes BMKG" });
        const handoverMs = Date.now() - startedAt;
        assert.ok(successor.epoch > bmkg.epoch, "new term, higher epoch");
        assert.ok(handoverMs < TTL_S * 1000, `handover took ${handoverMs} ms, shorter than the ${TTL_S}s TTL: the lease was handed back`);

        const { code, at } = await leader.exited;
        assert.equal(code, 0, `exit code (output tail):\n${leader.output().slice(-600)}`);
        assert.ok(at - startedAt >= DRAIN_MS, `waited the drain window (${at - startedAt} ms)`);
        const gone = await leader.call("/health");
        assert.equal(gone.status, "ERR", "port closed after the drain");

        const log = leader.output();
        assert.match(log, /shutdown_begin/);
        assert.match(log, /shutdown_done/);
        assert.match(log, /\[lease\] dilepas:/);

        console.log(`\n  graceful shutdown: not-ready in <300 ms, served requests while draining, lease handed over in ${handoverMs} ms (TTL ${TTL_S}s), clean exit after ${at - startedAt} ms`);
    } finally {
        for (const s of servers) s.proc.kill("SIGKILL");
        await Promise.allSettled([ingest.end()]);
        await sleep(300);
        await pg.stop();
    }
});

test("an instance that reaches no shard reports unready (and stays alive)", { skip, timeout: 60_000 }, async () => {
    const pg = await startTempPostgres(["ingest"]);
    const ingest = new Pool({ connectionString: pg.url("ingest") });
    await ingest.query(fs.readFileSync(path.join(ROOT, "../k8s/databases/ingest-init.sql"), "utf8"));
    const dead = await freePort(); // nothing listens here
    const s = startServer("agg-X", await freePort(), {
        INGEST_DATABASE_URL: pg.url("ingest"), SHARD_1_URI: `postgres://postgres@127.0.0.1:${dead}/none`,
    });
    try {
        const r = await waitFor(async () => {
            const res = await s.call("/health/ready");
            return res.status === 503 && res.body?.reasons?.includes("no_shard_reachable") ? res : null;
        }, { label: "unready because no shard", timeoutMs: 30_000 }).catch((e) => { throw new Error(`${e.message}\n${s.output().slice(-1500)}`); });
        assert.deepEqual([r.body.shardsUp, r.body.shardsTotal], [0, 1]);
        assert.equal((await s.call("/health")).status, 200, "still alive: Kubernetes must not restart it for this");
    } finally {
        s.proc.kill("SIGKILL");
        await ingest.end();
        await sleep(300);
        await pg.stop();
    }
});
