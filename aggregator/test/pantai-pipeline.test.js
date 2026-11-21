// Sensor Pantai end to end inside one process: a fake sensor that misbehaves, a real PostgreSQL
// (ingest + one shard), the real poller job, outbox and relay. Only RabbitMQ is replaced by a stub.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");
const { startTempPostgres, postgresAvailable } = require("./helpers/tempPostgres");

const skip = postgresAvailable() ? false : "PostgreSQL (initdb/pg_ctl) not found; set PG_BIN";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = path.join(__dirname, "..");

const STATIONS = [{ station_id: "stn-1", name: "Padang", province: "Sumatera Barat", latitude: -0.95, longitude: 100.35 }];
const BASE = Date.parse("2026-11-12T00:00:00Z");
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const obs = (i, patch = {}) => ({
    observation_id: `obs-${i}`, station_id: "stn-1", observed_at: iso(BASE + i * 1000),
    sea_level_anomaly_m: 0.1, wave_height_m: 1.0, quality: "ok", critical: false, ...patch,
});

test("Sensor Pantai: contract, critical path, breaker, staleness, burst", { skip, timeout: 120_000 }, async (t) => {
    const pg = await startTempPostgres(["ingest", "shard1"]);
    Object.assign(process.env, {
        INGEST_DATABASE_URL: pg.url("ingest"), SHARD_COUNT: "1", SHARD_1_URI: pg.url("shard1"),
        PANTAI_AUTH_TOKEN: "tok", PANTAI_TIMEOUT_MS: "800", PANTAI_MAX_LAG_S: "60", PANTAI_PAGE_LIMIT: "50",
        BREAKER_FAILURES: "2", BREAKER_OPEN_MS: "400", BREAKER_MAX_OPEN_MS: "1600",
    });

    // ---- the fake sensor: behaviour is switched by the test
    const sensor = { mode: "ok", pages: [], generatedAt: null, requests: [], auth: [] };
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        sensor.requests.push(url.pathname);
        sensor.auth.push(req.headers.authorization);
        res.setHeader("content-type", "application/json");
        if (sensor.mode === "down") { res.statusCode = 500; return res.end("{}"); }
        if (sensor.mode === "hang") return; // never answers: the client must time out
        if (url.pathname === "/v1/stations") return res.end(JSON.stringify({ items: STATIONS }));
        if (url.pathname === "/v1/observations") {
            const idx = Number(url.searchParams.get("cursor") ?? 0);
            const items = sensor.pages[idx] ?? [];
            const more = idx + 1 < sensor.pages.length;
            const newest = Math.max(BASE, ...items.map((o) => Date.parse(o.observed_at)).filter(Number.isFinite));
            return res.end(JSON.stringify({
                generated_at: sensor.generatedAt ?? iso(newest + 5000), items, next_cursor: more ? String(idx + 1) : (sensor.pages.length ? String(idx) : null),
            }));
        }
        res.statusCode = 404; res.end("{}");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    process.env.PANTAI_BASE_URL = `http://127.0.0.1:${server.address().port}`;

    const ingest = new Pool({ connectionString: pg.url("ingest") });
    const shard = new Pool({ connectionString: pg.url("shard1") });
    await ingest.query(fs.readFileSync(path.join(ROOT, "../k8s/databases/ingest-init.sql"), "utf8"));
    await shard.query(fs.readFileSync(path.join(ROOT, "migrations/001_create_hazard_events.sql"), "utf8"));

    // RabbitMQ stub, installed before the relay module captures the function
    const published = [];
    const broker = { up: false };
    require("../src/broker/publisher").publishConfirmed = async (event, opt) => {
        if (!broker.up) throw new Error("RabbitMQ belum terhubung");
        published.push({ id: event.hazard_id, key: opt.routingKey, messageId: opt.messageId });
    };

    const outbox = require("../src/store/criticalOutbox");
    await outbox.ensureSchema();
    const { pollPantai, breaker, _resetForTest } = require("../src/ingest/pollPantai");
    const { relayOnce } = require("../src/ingest/outboxRelay");
    const { getRawCursor } = require("../src/store/ingestStatus");
    const count = async (db, sql) => Number((await db.query(sql)).rows[0].n);
    const poll = async () => pollPantai(await getRawCursor("SENSOR_PANTAI"), null);
    const resetCursor = () => ingest.query("UPDATE ingest_status SET last_cursor = NULL WHERE source = 'SENSOR_PANTAI'");

    try {
        await t.test("invalid data is set aside with a reason; valid data is stored; criticals go to the outbox", async () => {
            sensor.pages = [[
                obs(1),
                obs(2, { critical: true, sea_level_anomaly_m: 2.5 }),
                obs(3, { critical: true, quality: "faulty" }),         // critical but the instrument says it is faulty
                obs(4, { wave_height_m: "tinggi" }),                   // wrong type
                obs(5, { station_id: "stn-ghost" }),                   // unknown station
                { observation_id: "obs-6" },                           // missing everything
                obs(7, { sea_level_anomaly_m: 9999 }),                 // physically impossible
            ]];
            await poll();
            assert.equal(await count(shard, "SELECT count(*) n FROM hazard_events"), 2, "only the 2 valid ones are HazardEvents");
            const rej = (await ingest.query("SELECT source_ref_id, reason FROM rejected_messages WHERE source='SENSOR_PANTAI' ORDER BY source_ref_id")).rows;
            assert.equal(rej.length, 5);
            assert.ok(rej.every((r) => r.reason.length > 10), "each carries a reason");
            assert.match(rej.find((r) => r.source_ref_id === "obs-3").reason, /quality_not_ok/);
            assert.equal(await count(ingest, "SELECT count(*) n FROM critical_outbox"), 1, "only the valid critical alert is queued");
            assert.ok(sensor.auth.every((a) => a === "Bearer tok"), "every request carried the sensor token");
        });

        await t.test("an alert survives a broker outage and is delivered exactly once after it", async () => {
            broker.up = false;
            await relayOnce();
            assert.equal((await outbox.pendingStats()).pending, 1, "broker down: alert kept, not dropped");
            assert.equal(published.length, 0);

            await poll(); // the same page again must not create a second alert
            assert.equal(await count(ingest, "SELECT count(*) n FROM critical_outbox"), 1, "re-polling does not duplicate the alert");

            broker.up = true;
            await relayOnce();
            await relayOnce();
            assert.equal(published.length, 1, "delivered once");
            assert.equal(published[0].key, "hazard.coastal.awas", "routed to the Tim Lapangan notifier binding");
            assert.equal(published[0].messageId, published[0].id, "stable messageId for consumer de-duplication");
            assert.equal((await outbox.pendingStats()).pending, 0);
        });

        await t.test("a burst is stored completely and the critical alert inside it is queued", async () => {
            sensor.pages = [0, 1, 2].map((p) => Array.from({ length: 50 }, (_, i) => obs(1000 + p * 50 + i)));
            sensor.pages[2][49] = obs(9999, { critical: true });
            await poll();
            assert.equal(await count(shard, "SELECT count(*) n FROM hazard_events WHERE source_ref_id LIKE 'obs-1___' OR source_ref_id='obs-9999'"), 150);
            assert.equal(await count(ingest, "SELECT count(*) n FROM critical_outbox"), 2);
            assert.equal(await getRawCursor("SENSOR_PANTAI"), "2", "progress persisted");
        });

        await t.test("sensor DOWN or HANGING: requests stop (breaker), then it recovers by itself", async () => {
            _resetForTest();
            await resetCursor();
            sensor.pages = [[obs(2000)]];
            for (const mode of ["down", "hang"]) {
                sensor.mode = mode;
                sensor.requests.length = 0;
                for (let i = 0; i < 40; i++) await poll(); // 40 polling cycles in a row
                assert.equal(breaker.state, "open", `${mode}: breaker opened`);
                assert.ok(sensor.requests.length <= 3, `${mode}: only ${sensor.requests.length} requests reached the sensor in 40 cycles`);

                sensor.mode = "ok";
                await sleep(2200); // longer than the (capped) cool-down
                await poll();
                assert.equal(breaker.state, "closed", `${mode}: closed again with no intervention`);
            }
            assert.equal(await count(shard, "SELECT count(*) n FROM hazard_events WHERE source_ref_id='obs-2000'"), 1, "data flows again");
        });

        await t.test("sensor says 200 but its newest data is hours old: treated as unhealthy", async () => {
            _resetForTest();
            await resetCursor();
            sensor.mode = "ok";
            sensor.pages = [[obs(3000, { observed_at: "2026-11-12T00:00:00Z" })]];
            sensor.generatedAt = "2026-11-12T05:00:00Z"; // 5 h later
            sensor.requests.length = 0;
            for (let i = 0; i < 30; i++) await poll();
            assert.equal(breaker.state, "open", "stale-but-200 trips the breaker");
            assert.ok(sensor.requests.length <= 6, `requests stayed low (${sensor.requests.length})`);
            assert.equal(await count(shard, "SELECT count(*) n FROM hazard_events WHERE source_ref_id='obs-3000'"), 1, "its data was still kept");
            const st = (await ingest.query("SELECT last_error_message m FROM ingest_status WHERE source='SENSOR_PANTAI'")).rows[0];
            assert.match(st.m, /mengaku sehat|circuit/);

            sensor.generatedAt = null; // fresh again: generated_at follows the data
            await resetCursor();
            sensor.pages = [[obs(3001)]];
            await sleep(2200);
            await poll();
            assert.equal(breaker.state, "closed", "recovers when the data is fresh");
        });
    } finally {
        server.closeAllConnections?.();
        await new Promise((r) => server.close(r));
        await Promise.allSettled([ingest.end(), shard.end(), require("../src/store/ingestStatus").pool.end()]);
        await sleep(300);
        await pg.stop();
    }
});
