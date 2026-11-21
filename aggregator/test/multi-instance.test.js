// Three real aggregator processes against one fake upstream, one database and one shard.
// Proves, with the upstream's own request log as evidence:
//   - every source is polled by exactly one instance at a time (no multiplied upstream load),
//   - when that instance is killed, another continues within the lease TTL,
//   - the handover loses nothing and stores nothing twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Pool } = require("pg");
const { startTempPostgres, postgresAvailable } = require("./helpers/tempPostgres");

const skip = postgresAvailable() ? false : "PostgreSQL (initdb/pg_ctl) not found; set PG_BIN";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POLL_INTERVAL_MS = 500;
const LEASE_TTL_S = 3;

const evt = (i) => ({
    event_id: `EQ-${i}`, magnitude: 5.5, depth_km: 10,
    epicenter_lat: -6.2, epicenter_lon: 106.8, region_name: "Jawa Barat",
    occurred_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, potential_tsunami: false,
});

test("3 instances: one poller per source, takeover within the TTL, no gaps, no duplicates", { skip, timeout: 120_000 }, async () => {
    const pg = await startTempPostgres(["ingest", "shard1"]);
    const log = []; // every request the upstream received
    let available = [1, 2, 3].map(evt);

    const upstream = http.createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        log.push({
            t: Date.now(), path: url.pathname, since: url.searchParams.get("since"),
            poller: req.headers["x-poller-id"] ?? null, epoch: req.headers["x-fence-epoch"] ?? null,
            correlation: req.headers["x-correlation-id"] ?? null,
        });
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/seismic-events") {
            const since = url.searchParams.get("since");
            return res.end(JSON.stringify(available.filter((e) => e.occurred_at > since)));
        }
        if (url.pathname === "/tsunami-warnings") return res.end("[]");
        res.statusCode = 500; // PVMBG and satellite are not under test; the requests still count
        res.end("{}");
    });
    await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${upstream.address().port}`;

    const ingest = new Pool({ connectionString: pg.url("ingest") });
    const shard = new Pool({ connectionString: pg.url("shard1") });
    await ingest.query(fs.readFileSync(path.join(__dirname, "../../k8s/databases/ingest-init.sql"), "utf8"));

    const env = {
        ...process.env,
        INGEST_DATABASE_URL: pg.url("ingest"), SHARD_COUNT: "1", SHARD_1_URI: pg.url("shard1"),
        BMKG_BASE_URL: base, PVMBG_BASE_URL: base, SATELLITE_PROCESSOR_URL: base,
        BMKG_API_KEY: "k", PVMBG_TOKEN: "t", SATELLITE_PROCESSOR_API_KEY: "s",
        POLL_INTERVAL_MS: String(POLL_INTERVAL_MS), LEASE_TTL_SECONDS: String(LEASE_TTL_S), SOURCE_TIMEOUT_MS: "1000",
    };
    // shard schema first, so the instances do not race to create it
    await new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ["-e", "require('./src/db/migrate').migrateAll().then(()=>process.exit(0))"],
            { cwd: path.join(__dirname, ".."), env, stdio: "ignore" });
        p.on("exit", (c) => (c === 0 ? resolve() : reject(new Error(`migrate exited ${c}`))));
    });

    const instances = ["agg-A", "agg-B", "agg-C"].map((name) => ({
        name,
        proc: spawn(process.execPath, [path.join(__dirname, "helpers/pollerRunner.js")],
            { cwd: path.join(__dirname, ".."), env: { ...env, POD_NAME: name }, stdio: "ignore" }),
    }));

    try {
        // ---- 1. steady state: who talks to the upstream?
        await sleep(7000);
        const bySource = { BMKG: "/seismic-events", PVMBG: "/volcanic-reports", SATELIT: "/fires" };
        const steady = log.filter((r) => r.poller);
        for (const [source, p] of Object.entries(bySource)) {
            const pollers = new Set(steady.filter((r) => r.path === p).map((r) => r.poller.split(".")[0]));
            assert.equal(pollers.size, 1, `${source}: requests came from ${[...pollers]} (must be exactly one instance)`);
        }
        assert.equal(log.filter((r) => !r.poller).length, 0, "every upstream request is tagged with its poller");
        const seismic = steady.filter((r) => r.path === "/seismic-events").length;
        assert.ok(seismic <= 20, `BMKG requests in ~7s: ${seismic} (3 uncoordinated instances would send ~40)`);

        const bmkgLeader = steady.find((r) => r.path === "/seismic-events").poller.split(".")[0];
        const stored = async () => (await shard.query("SELECT source_ref_id FROM hazard_events WHERE source='BMKG' ORDER BY 1")).rows.map((r) => r.source_ref_id);
        assert.deepEqual(await stored(), ["EQ-1", "EQ-2", "EQ-3"]);
        const cursorBefore = (await ingest.query("SELECT last_cursor FROM ingest_status WHERE source='BMKG'")).rows[0].last_cursor;
        assert.equal(cursorBefore, evt(3).occurred_at);

        // ---- 2. kill the BMKG leader hard (no chance to release the lease), and new data arrives
        const victim = instances.find((i) => i.name === bmkgLeader);
        const killedAt = Date.now();
        victim.proc.kill("SIGKILL");
        available = [1, 2, 3, 4, 5, 6].map(evt);

        let successor = null;
        while (Date.now() - killedAt < 20_000 && !successor) {
            await sleep(200);
            successor = log.find((r) => r.t > killedAt && r.path === "/seismic-events" && r.poller && !r.poller.startsWith(bmkgLeader));
        }
        assert.ok(successor, "another instance took over BMKG");
        const takeoverMs = successor.t - killedAt;
        assert.ok(takeoverMs <= (LEASE_TTL_S + 2) * 1000, `takeover took ${takeoverMs} ms (TTL ${LEASE_TTL_S}s)`);
        assert.ok(takeoverMs <= 60_000, "criterion 3: within 60 seconds");

        // gap-free: the new leader resumed from the last committed cursor, not from the beginning
        assert.equal(successor.since, cursorBefore, "resumed exactly at the previous cursor");
        assert.ok(Number(successor.epoch) >= 2, "a higher epoch, i.e. a new term");

        // ---- 3. the new data arrives exactly once
        await sleep(3000);
        assert.deepEqual(await stored(), ["EQ-1", "EQ-2", "EQ-3", "EQ-4", "EQ-5", "EQ-6"], "no gap, no duplicate");
        const after = log.filter((r) => r.t > killedAt && r.path === "/seismic-events" && r.poller);
        const afterPollers = new Set(after.filter((r) => r.t > successor.t).map((r) => r.poller.split(".")[0]));
        assert.equal(afterPollers.size, 1, `after takeover only one instance polls BMKG, saw ${[...afterPollers]}`);
        assert.ok(!afterPollers.has(bmkgLeader), "and it is not the one that was killed");

        const evidence = log.filter((r) => r.path === "/seismic-events" && r.poller).slice(0, 3)
            .concat(after.slice(0, 2)).map((r) => `${r.correlation}  since=${r.since}`);
        console.log("\n  upstream log (X-Correlation-ID shows who polled, under which epoch):\n   " + evidence.join("\n   "));
        console.log(`  takeover after kill: ${takeoverMs} ms (TTL ${LEASE_TTL_S}s)`);
    } finally {
        for (const i of instances) i.proc.kill("SIGKILL");
        await Promise.allSettled([ingest.end(), shard.end()]);
        await new Promise((r) => upstream.close(r));
        await sleep(500);
        await pg.stop();
    }
});
