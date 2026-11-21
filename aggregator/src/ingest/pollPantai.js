// Polling of Sensor Pantai: the source that is both the most important and the least trustworthy.
//
//   * every upstream call (stations and observations) goes through ONE circuit breaker, so when
//     the sensor is down or lying we stop calling it and probe with exponential back-off;
//   * a response that claims to be healthy but whose newest data is far behind its own
//     generated_at counts as a failure ("healthy but expired");
//   * each observation is checked against the base contract; violations are set aside with a
//     reason (rejected_messages) and never become a HazardEvent;
//   * a critical observation is first put in the outbox (so the alert cannot be lost), then
//     stored; the relay delivers it to Tim Lapangan (see outboxRelay.js);
//   * progress is persisted page by page and a burst is spread over cycles (MAX_PAGES).
const { getStations, getObservations } = require("../sources/pantaiClient");
const { BadPayloadError } = require("../sources/httpClient");
const { validateObservation, validateStation, parseTime } = require("../validators/pantaiValidator");
const { mapObservationToHazardEvent } = require("../mappers/pantaiMapper");
const { upsertHazardEvent } = require("../store/canonicalStore");
const { markPollSuccess, markPollError } = require("../store/ingestStatus");
const { saveRejected } = require("../store/rejectedStore");
const { publishHazardEvent } = require("../broker/publisher");
const outbox = require("../store/criticalOutbox");
const { CircuitBreaker, CircuitOpenError } = require("../resilience/circuitBreaker");
const { FencedError } = require("../coordination/errors");
const metrics = require("../metrics");

const SOURCE = "SENSOR_PANTAI";
const MAX_PAGES = Number(process.env.PANTAI_MAX_PAGES || 5);
const STATIONS_TTL_MS = Number(process.env.PANTAI_STATIONS_TTL_MS || 300000);
// How far (in the SENSOR's own time) the newest observation may lag behind generated_at before
// the sensor is considered stale although it answers 200.
const MAX_LAG_MS = Number(process.env.PANTAI_MAX_LAG_S || 900) * 1000;
const STATE = { closed: 0, half_open: 1, open: 2 };

class StaleSourceError extends Error {
    constructor(lagMs, body) {
        super(`sensor mengaku sehat tetapi data terbaru tertinggal ${Math.round(lagMs / 1000)} s dari generated_at`);
        this.name = "StaleSourceError";
        this.body = body;
    }
}

const breaker = new CircuitBreaker({
    name: "sensor_pantai",
    onChange: ({ from, to }) => {
        console.log(`[breaker] sensor_pantai: ${from} -> ${to}`);
        metrics.setGauge("pantai_breaker_state", STATE[to]);
        metrics.inc("pantai_breaker_transitions_total", { to });
    },
});
metrics.setGauge("pantai_breaker_state", 0);

let stations = { map: null, loadedAt: 0 };
let newestObservedMs = null; // newest observed_at seen, to judge staleness when a page is empty

// All upstream calls count towards the breaker and the request metric.
async function upstream(kind, fn) {
    try {
        const result = await breaker.exec(fn);
        metrics.inc("pantai_upstream_requests_total", { kind, outcome: "ok" });
        return result;
    } catch (err) {
        if (err instanceof CircuitOpenError) {
            metrics.inc("pantai_upstream_skipped_total", { kind });
        } else {
            metrics.inc("pantai_upstream_requests_total", { kind, outcome: err instanceof StaleSourceError ? "stale" : "error" });
        }
        throw err;
    }
}

async function ensureStations(force = false) {
    if (!force && stations.map && Date.now() - stations.loadedAt < STATIONS_TTL_MS) return stations.map;
    const body = await upstream("stations", async () => {
        const b = await getStations();
        if (!Array.isArray(b?.items)) throw new BadPayloadError("contract_violation: /v1/stations tanpa 'items'", JSON.stringify(b ?? null));
        return b;
    });
    const map = new Map();
    for (const st of body.items) if (!validateStation(st)) map.set(st.station_id, st);
    stations = { map, loadedAt: Date.now() };
    return map;
}

async function fetchPage(cursor) {
    return upstream("observations", async () => {
        const body = await getObservations(cursor);
        if (!Array.isArray(body?.items)) {
            throw new BadPayloadError("contract_violation: /v1/observations tanpa 'items'", JSON.stringify(body ?? null));
        }
        const generatedMs = parseTime(body.generated_at);
        if (Number.isNaN(generatedMs)) {
            throw new BadPayloadError("contract_violation: 'generated_at' tidak valid", JSON.stringify(body.generated_at ?? null));
        }
        // staleness is judged on the last page only (no next cursor, or one that does not move):
        // earlier pages are backlog, which is old by nature.
        if (!body.next_cursor || body.next_cursor === cursor || body.items.length === 0) {
            const pageNewest = body.items.map((o) => parseTime(o?.observed_at)).filter(Number.isFinite);
            const newest = Math.max(newestObservedMs ?? -Infinity, ...pageNewest);
            if (Number.isFinite(newest)) {
                newestObservedMs = newest;
                if (generatedMs - newest > MAX_LAG_MS) throw new StaleSourceError(generatedMs - newest, body);
            }
        }
        return body;
    });
}

async function processObservation(obs, { generatedMs, stationMap }, ctx) {
    const reason = validateObservation(obs, { generatedAt: generatedMs, stations: stationMap });
    if (reason) {
        await saveRejected({
            source: SOURCE,
            sourceRefId: typeof obs?.observation_id === "string" ? obs.observation_id : null,
            rawPayload: JSON.stringify(obs ?? null),
            reason,
            retryable: false,
        });
        metrics.inc("pantai_observations_total", { result: "rejected" });
        metrics.inc("pantai_rejected_total", { reason: reason.split(":")[0] });
        return;
    }

    const event = mapObservationToHazardEvent(obs, stationMap.get(obs.station_id));
    if (obs.critical) {
        // 1. the alert is safe the moment it is in the outbox; 2. then store it.
        await outbox.enqueue(event, `hazard.coastal.${event.severity.toLowerCase()}`);
        await upsertHazardEvent(event, ctx);
        metrics.inc("pantai_critical_total");
    } else {
        const { inserted } = await upsertHazardEvent(event, ctx);
        if (inserted) publishHazardEvent(event);
    }
    metrics.inc("pantai_observations_total", { result: "accepted" });
}

async function processPage(body, ctx) {
    const generatedMs = parseTime(body.generated_at);
    let stationMap = await ensureStations();
    // a station we do not know yet may simply be new: refresh the list once per page
    if (body.items.some((o) => o && typeof o.station_id === "string" && !stationMap.has(o.station_id))) {
        stationMap = await ensureStations(true);
    }
    // critical observations first, so a burst can never delay an alert behind routine data
    const ordered = [...body.items].sort((a, b) => Number(b?.critical === true) - Number(a?.critical === true));
    for (const obs of ordered) await processObservation(obs, { generatedMs, stationMap }, ctx);
}

let lastOpenLog = 0;

async function pollPantai(cursor, ctx = null) {
    let next = cursor ?? null;
    try {
        for (let page = 0; page < MAX_PAGES; page++) {
            let body;
            try {
                body = await fetchPage(next);
            } catch (err) {
                if (err instanceof StaleSourceError) {
                    // the data in a stale response is still real: keep it, but count the failure
                    await processPage(err.body, ctx);
                }
                throw err;
            }
            await processPage(body, ctx);
            const advanced = body.next_cursor && body.next_cursor !== next;
            if (advanced) next = body.next_cursor;
            await markPollSuccess(SOURCE, next, ctx); // also the heartbeat read by the API (stale detection)
            if (!advanced || body.items.length === 0) break;
        }
    } catch (error) {
        if (error instanceof FencedError) {
            console.log(`[poll] ${SOURCE}: dihentikan, leader sudah digantikan - ${error.message}`);
            return;
        }
        if (error instanceof CircuitOpenError) {
            if (Date.now() - lastOpenLog > 30000) {
                lastOpenLog = Date.now();
                console.log(`[poll] ${SOURCE}: ${error.message} (tidak memanggil sensor)`);
            }
        } else {
            console.log(`[poll] ${SOURCE}: GAGAL - ${error.message}`);
            if (error instanceof BadPayloadError) {
                await saveRejected({ source: SOURCE, rawPayload: error.raw ?? "", reason: error.reason, retryable: false })
                    .catch((e) => console.log(`[poll] ${SOURCE}: gagal menyimpan pesan rusak - ${e.message}`));
            }
        }
        await markPollError(SOURCE, error.message, ctx).catch(() => { });
    }
}

module.exports = { pollPantai, breaker, StaleSourceError, _resetForTest: () => { stations = { map: null, loadedAt: 0 }; newestObservedMs = null; } };
