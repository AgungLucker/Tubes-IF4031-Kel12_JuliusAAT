// Lease + fencing semantics, against a real PostgreSQL.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTempPostgres, postgresAvailable } = require("./helpers/tempPostgres");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const skip = postgresAvailable() ? false : "PostgreSQL (initdb/pg_ctl) not found; set PG_BIN";

let pg;
let m; // modules, loaded after the environment points at the temp server

const event = (ref, source = "BMKG") => ({
    source, source_ref_id: ref, hazard_type: "SEISMIC", severity: "WASPADA",
    area_name: "Test", latitude: -6.2, longitude: 106.8,
    occurred_at: "2026-01-01T00:00:00.000Z", attributes: { m: 5.5 },
});

async function rows(source) {
    const { rows: r } = await m.shardPool.query(
        "SELECT source_ref_id FROM hazard_events WHERE source = $1 ORDER BY source_ref_id", [source]);
    return r.map((x) => x.source_ref_id);
}

test.before(async () => {
    if (skip) return;
    pg = await startTempPostgres(["ingest", "shard1"]);
    process.env.INGEST_DATABASE_URL = pg.url("ingest");
    process.env.SHARD_COUNT = "1";
    process.env.SHARD_1_URI = pg.url("shard1");

    const { makePool, shards } = require("../src/db/shards");
    const ingest = require("../src/store/ingestStatus");
    const initSql = fs.readFileSync(path.join(__dirname, "../../k8s/databases/ingest-init.sql"), "utf8");
    await ingest.pool.query(initSql);
    await ingest.leases.ensureSchema();
    await require("../src/db/migrate").migrateAll();

    m = {
        pool: ingest.pool,
        shardPool: shards[0].pool,
        shards,
        makePool,
        ingest,
        LeaseStore: require("../src/coordination/lease").LeaseStore,
        installFence: require("../src/coordination/fence").installFence,
        FencedError: require("../src/coordination/errors").FencedError,
        store: require("../src/store/canonicalStore"),
    };
});

test.after(async () => {
    if (skip) return;
    await Promise.allSettled([m.pool.end(), m.shardPool.end()]);
    await pg.stop();
});

const store = (holder, ttlSeconds = 30) => new m.LeaseStore(m.pool, { holder, ttlSeconds });

test("mutual exclusion: concurrent candidates, exactly one leader every time", { skip }, async () => {
    for (let round = 0; round < 25; round++) {
        const name = `mutex-${round}`;
        const results = await Promise.all(["A", "B", "C"].map((h) => store(h).acquireOrRenew(name)));
        assert.equal(results.filter(Boolean).length, 1, `round ${round}`);
        assert.equal(results.find(Boolean).epoch, 1);
    }
});

test("renewal keeps the epoch, a rival is refused while the lease is live", { skip }, async () => {
    const a = store("A"), b = store("B");
    const first = await a.acquireOrRenew("renew");
    const again = await a.acquireOrRenew("renew");
    assert.deepEqual([first.epoch, first.newTerm], [1, true]);
    assert.deepEqual([again.epoch, again.newTerm], [1, false]);
    assert.equal(await b.acquireOrRenew("renew"), null);
});

test("takeover after expiry bumps the epoch and fences the old leader's cursor update", { skip }, async () => {
    const a = store("A", 1), b = store("B", 30);
    const lease = await a.acquireOrRenew("PVMBG");
    await m.ingest.markPollSuccess("PVMBG", "2026-01-01T00:00:01.000Z", { holder: "A", epoch: lease.epoch });

    await sleep(1500); // A's lease runs out (by the DB clock)
    const taken = await b.acquireOrRenew("PVMBG");
    assert.equal(taken.epoch, lease.epoch + 1);
    assert.equal(taken.newTerm, true);

    assert.equal(await a.acquireOrRenew("PVMBG"), null);
    await assert.rejects(
        m.ingest.markPollSuccess("PVMBG", "2026-01-01T00:00:09.000Z", { holder: "A", epoch: lease.epoch }),
        m.FencedError);
    assert.equal(await m.ingest.getCursor("PVMBG"), "2026-01-01T00:00:01.000Z", "stale leader must not move the cursor");
    await m.ingest.markPollSuccess("PVMBG", "2026-01-01T00:00:05.000Z", { holder: "B", epoch: taken.epoch });
});

test("the same holder coming back after its lease expired still gets a NEW epoch", { skip }, async () => {
    const a = store("A", 1);
    const first = await a.acquireOrRenew("same-holder");
    await sleep(1500);
    const back = await a.acquireOrRenew("same-holder");
    assert.equal(back.epoch, first.epoch + 1);
    assert.equal(back.newTerm, true);
});

test("graceful release lets another instance take over immediately", { skip }, async () => {
    const a = store("A", 60), b = store("B", 60);
    const first = await a.acquireOrRenew("release");
    assert.equal(await b.acquireOrRenew("release"), null);
    assert.equal(await a.release("release"), true);
    const next = await b.acquireOrRenew("release"); // no waiting for the 60s TTL
    assert.equal(next.epoch, first.epoch + 1);
});

test("clock skew on a node changes nothing: only the database clock counts", { skip }, async () => {
    const realNow = Date.now;
    try {
        for (const skewMs of [45_000, -30_000]) {
            Date.now = () => realNow() + skewMs;
            const name = `skew-${skewMs}`;
            const a = store("A", 2), b = store("B", 2);
            const l1 = await a.acquireOrRenew(name);
            assert.equal(l1.epoch, 1);
            assert.equal(await b.acquireOrRenew(name), null, "rival refused although clocks disagree");
            assert.equal((await a.acquireOrRenew(name)).epoch, 1, "leader keeps renewing");
            await sleep(2300);
            const l2 = await b.acquireOrRenew(name);
            assert.equal(l2.epoch, 2, "takeover happens when the DB says the lease expired, not before or after");
        }
    } finally {
        Date.now = realNow;
    }
});

test("shard fence: a stale epoch stores nothing, the leader's retry is idempotent", { skip }, async () => {
    const fence = (epoch) => ({ source: "BMKG", epoch });
    const ok = await m.store.upsertHazardEvent(event("e1"), fence(3));
    assert.equal(ok.inserted, true);

    await assert.rejects(m.store.upsertHazardEvent(event("stale"), fence(2)), m.FencedError);
    assert.deepEqual(await rows("BMKG"), ["e1"], "the stale write left no trace");

    const retry = await m.store.upsertHazardEvent(event("e1"), fence(3));
    assert.equal(retry.changed, false, "same event again is a no-op");
    assert.deepEqual(await rows("BMKG"), ["e1"]);

    await assert.rejects(m.store.deleteHazardEvent("BMKG", "e1", fence(1)), m.FencedError);
    assert.deepEqual(await rows("BMKG"), ["e1"], "stale delete is fenced too");
});

test("a frozen leader that wakes up cannot store anything (criterion 5)", { skip }, async () => {
    const SRC = "SATELIT";
    const a = store("A", 1), b = store("B", 30);

    // A leads, fences the shards and starts working...
    const termA = await a.acquireOrRenew(SRC);
    await m.installFence(m.shards, SRC, termA.epoch);
    await m.store.upsertHazardEvent(event("a-before-freeze", SRC), { source: SRC, epoch: termA.epoch });

    // ...then the machine freezes (lid closed / VM suspended). Its own clocks stop with it.
    await sleep(1500);

    // B takes over and does the poll.
    const termB = await b.acquireOrRenew(SRC);
    assert.equal(termB.epoch, termA.epoch + 1);
    await m.installFence(m.shards, SRC, termB.epoch);
    await m.store.upsertHazardEvent(event("b1", SRC), { source: SRC, epoch: termB.epoch });
    await m.store.upsertHazardEvent(event("b2", SRC), { source: SRC, epoch: termB.epoch });
    await m.ingest.markPollSuccess(SRC, "2026-01-01T00:00:07.000Z", { holder: "B", epoch: termB.epoch });

    // A wakes up, still believing it is the leader, and carries on with the poll it was in.
    await assert.rejects(m.store.upsertHazardEvent(event("a-after-freeze", SRC), { source: SRC, epoch: termA.epoch }), m.FencedError);
    await assert.rejects(m.store.deleteHazardEvent(SRC, "b1", { source: SRC, epoch: termA.epoch }), m.FencedError);
    await assert.rejects(m.ingest.markPollSuccess(SRC, "2026-01-01T00:00:99.000Z", { holder: "A", epoch: termA.epoch }), m.FencedError);
    assert.equal(await a.acquireOrRenew(SRC), null, "and it is no longer the leader either");

    assert.deepEqual(await rows(SRC), ["a-before-freeze", "b1", "b2"], "nothing from A after the takeover");
    assert.equal(await m.ingest.getCursor(SRC), "2026-01-01T00:00:07.000Z");
});

test("fence installation locks out a stale leader on shards the new leader has not written to", { skip }, async () => {
    const SRC = "PVMBG";
    await m.installFence(m.shards, SRC, 5);
    await assert.rejects(m.store.upsertHazardEvent(event("late", SRC), { source: SRC, epoch: 4 }), m.FencedError);
    await assert.rejects(m.installFence(m.shards, SRC, 4), m.FencedError, "a stale leader cannot even install its fence");
    assert.deepEqual(await rows(SRC), []);
});
