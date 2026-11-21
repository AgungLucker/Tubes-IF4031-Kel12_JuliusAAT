// Sensor Pantai building blocks without any I/O: circuit breaker, contract validator, mapper.
const test = require("node:test");
const assert = require("node:assert/strict");
const { CircuitBreaker, CircuitOpenError } = require("../src/resilience/circuitBreaker");
const { validateObservation, validateStation } = require("../src/validators/pantaiValidator");
const { mapObservationToHazardEvent } = require("../src/mappers/pantaiMapper");

const ok = () => Promise.resolve("ok");
const boom = () => Promise.reject(new Error("boom"));
const failWith = async (cb, fn) => { try { await cb.exec(fn); } catch (e) { return e; } };

function makeBreaker(extra = {}) {
    const clock = { t: 0 };
    const cb = new CircuitBreaker({
        name: "t", failureThreshold: 3, openMs: 1000, maxOpenMs: 8000, jitter: 0,
        now: () => clock.t, random: () => 0.5, ...extra,
    });
    return { cb, clock };
}

test("breaker: opens after N consecutive failures and then makes NO calls", async () => {
    const { cb } = makeBreaker();
    let calls = 0;
    const failing = () => { calls++; return boom(); };
    for (let i = 0; i < 3; i++) await failWith(cb, failing);
    assert.equal(cb.state, "open");
    for (let i = 0; i < 50; i++) assert.ok((await failWith(cb, failing)) instanceof CircuitOpenError);
    assert.equal(calls, 3, "50 more attempts while open reached the upstream 0 times");
});

test("breaker: one success resets the failure count", async () => {
    const { cb } = makeBreaker();
    await failWith(cb, boom); await failWith(cb, boom);
    await cb.exec(ok);
    await failWith(cb, boom); await failWith(cb, boom);
    assert.equal(cb.state, "closed", "2+2 failures separated by a success must not open it");
});

test("breaker: half-open lets exactly one probe through; success closes it", async () => {
    const { cb, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) await failWith(cb, boom);
    clock.t = 1001; // cool-down over
    let release; const slow = new Promise((r) => (release = r));
    const probe = cb.exec(() => slow);                      // the single probe, still running
    assert.equal(cb.state, "half_open");
    assert.ok((await failWith(cb, ok)) instanceof CircuitOpenError, "a second concurrent call is refused");
    release("ok"); await probe;
    assert.equal(cb.state, "closed");
});

test("breaker: failed probe re-opens with a longer cool-down (exponential back-off, capped)", async () => {
    const { cb, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) await failWith(cb, boom);
    const waits = [];
    for (let i = 0; i < 6; i++) {
        waits.push(cb.snapshot().retryInMs);
        clock.t += cb.snapshot().retryInMs + 1;
        await failWith(cb, boom); // the probe fails
        assert.equal(cb.state, "open");
    }
    assert.deepEqual(waits, [1000, 2000, 4000, 8000, 8000, 8000], "doubles, then stays at the cap");
});

test("breaker: recovers by itself, with no intervention", async () => {
    const { cb, clock } = makeBreaker();
    for (let i = 0; i < 3; i++) await failWith(cb, boom);
    clock.t += 5000;
    assert.equal(await cb.exec(ok), "ok");
    assert.equal(cb.state, "closed");
    assert.equal(cb.snapshot().retryInMs, 0);
});

const good = {
    observation_id: "obs-1", station_id: "stn-1", observed_at: "2026-11-12T02:43:00Z",
    sea_level_anomaly_m: 0.42, wave_height_m: 1.8, quality: "ok", critical: false,
};
const stations = new Map([["stn-1", { station_id: "stn-1", name: "Padang", province: "Sumatera Barat", latitude: -0.95, longitude: 100.35 }]]);
const check = (patch, ctx = {}) => validateObservation({ ...good, ...patch }, { stations, ...ctx });

test("validator: a well-formed observation passes", () => {
    assert.equal(check({}), null);
    assert.equal(check({ critical: true, sea_level_anomaly_m: -3.2 }), null);
});

test("validator: contract violations are rejected with a reason", () => {
    const cases = [
        [{ observation_id: undefined }, /observation_id/],
        [{ station_id: 7 }, /station_id/],
        [{ observed_at: "yesterday" }, /observed_at/],
        [{ observed_at: 1731379380 }, /observed_at/],
        [{ sea_level_anomaly_m: "0.4" }, /sea_level_anomaly_m/],
        [{ sea_level_anomaly_m: null }, /sea_level_anomaly_m/],
        [{ sea_level_anomaly_m: NaN }, /sea_level_anomaly_m/],
        [{ sea_level_anomaly_m: 500 }, /out_of_range/],
        [{ wave_height_m: -1 }, /out_of_range/],
        [{ wave_height_m: "high" }, /wave_height_m/],
        [{ critical: "true" }, /critical/],
        [{ quality: undefined }, /quality/],
        [{ quality: "faulty" }, /quality_not_ok/],
        [{ station_id: "stn-404" }, /unknown_station/],
    ];
    for (const [patch, re] of cases) assert.match(check(patch) ?? "", re, JSON.stringify(patch));
    assert.match(validateObservation(null) ?? "", /bukan objek/);
    assert.match(validateObservation([good]) ?? "", /bukan objek/);
});

test("validator: an observation from the future of the sensor's own clock is rejected", () => {
    const gen = Date.parse("2026-11-12T02:43:05Z");
    assert.equal(check({}, { generatedAt: gen }), null);
    assert.match(check({ observed_at: "2026-11-12T02:50:00Z" }, { generatedAt: gen }) ?? "", /lebih baru/);
});

test("validator: stations", () => {
    assert.equal(validateStation(stations.get("stn-1")), null);
    assert.ok(validateStation({ station_id: "x", name: "y", latitude: 200, longitude: 0 }));
    assert.ok(validateStation(null));
});

test("mapper: a critical observation becomes an AWAS COASTAL HazardEvent with a stable id", () => {
    const st = stations.get("stn-1");
    const a = mapObservationToHazardEvent({ ...good, critical: true, extra_field: 1 }, st);
    const b = mapObservationToHazardEvent({ ...good, critical: true }, st);
    assert.equal(a.hazard_id, b.hazard_id, "same observation, same id (idempotent)");
    assert.deepEqual(
        [a.source, a.hazard_type, a.severity, a.area_name, a.occurred_at],
        ["SENSOR_PANTAI", "COASTAL", "AWAS", "Padang", "2026-11-12T02:43:00.000Z"]);
    assert.equal(a.attributes.extra_field, 1, "unknown fields are kept in attributes");
    assert.equal(mapObservationToHazardEvent(good, st).severity, "NORMAL");
});
