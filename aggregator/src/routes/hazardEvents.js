const express = require("express");
const { listLatest, HAZARD_TYPES, SOURCES } = require("../store/canonicalStore");
const { performance } = require("node:perf_hooks");
const { getIngestStatusWithAge } = require("../store/ingestStatus");
const { CursorError } = require("../store/cursor");

const router = express.Router();

const STALE_THRESHOLD_MS = Number(process.env.POLL_INTERVAL_MS || 3000) * 2;

// Source health is read from the shared ingest status (written by whichever instance leads that
// source), never from the sensor itself: the answer is local, fast, and still correct while the
// sensor is down. Cached for a second so a request burst does not become a query burst.
const PANTAI_STALE_AFTER_MS = Number(process.env.PANTAI_STALE_AFTER_MS || 15000);
let statusCache = { at: -Infinity, rows: [] };
async function cachedStatuses() {
    if (performance.now() - statusCache.at > 1000) {
        statusCache = { at: performance.now(), rows: await getIngestStatusWithAge() };
    }
    return statusCache.rows;
}

// Umur poll sukses terakhir saat ini = umur menurut DB saat diambil + lama baris itu di cache.
function ageMs(row) {
    if (row?.age_ms === null || row?.age_ms === undefined) return null;
    return Number(row.age_ms) + (performance.now() - statusCache.at);
}

// "ok" | "stale" | "unknown", plus the time of the last good poll, for the sensor-dependent part
// of a response.
async function sensorStatus() {
    try {
        const row = (await cachedStatuses()).find((s) => s.source === "SENSOR_PANTAI");
        if (!row?.last_success_at) return { status: "unknown" };
        const last = new Date(row.last_success_at);
        return ageMs(row) > PANTAI_STALE_AFTER_MS
            ? { status: "stale", stale_since: last.toISOString() }
            : { status: "ok", last_success_at: last.toISOString() };
    } catch {
        return { status: "unknown" };
    }
}

async function staleSince() {
    try {
        const statuses = await cachedStatuses();
        const pvmbg = statuses.find((s) => s.source === "PVMBG");
        if (!pvmbg?.last_success_at) return undefined;
        const last = new Date(pvmbg.last_success_at);
        return ageMs(pvmbg) > STALE_THRESHOLD_MS ? last.toISOString() : undefined;
    } catch (err) {
        console.error(`[hazard-events] status ingest tidak terbaca: ${err.message}`);
        return undefined;
    }
}

router.get("/", async (req, res) => {
    const { hazard_type: hazardType, source, cursor } = req.query;
    if (hazardType && !HAZARD_TYPES.includes(hazardType)) {
        return res.status(400).json({ error: { code: "bad_request", message: "hazard_type tidak dikenal" } });
    }
    if (source && !SOURCES.includes(source)) {
        return res.status(400).json({ error: { code: "bad_request", message: "source tidak dikenal" } });
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

    let page;
    try {
        page = await listLatest({ hazardType, source, limit, cursor });
    } catch (err) {
        if (err instanceof CursorError) {
            return res.status(400).json({ error: { code: "bad_request", message: err.message } });
        }
        console.error(err);
        return res.status(503).json({ error: { code: "unavailable", message: "penyimpanan sementara tidak tersedia" } });
    }

    const response = {
        data: page.items,
        next_cursor: page.next_cursor,
        partial: page.partial,
        unavailable_units: page.unavailable_units,
    };

    if (!hazardType || hazardType === "VOLCANIC") {
        const stale = await staleSince();
        if (stale) response.stale_since = stale;
    }
    if ((!hazardType || hazardType === "COASTAL") && (!source || source === "SENSOR_PANTAI")) {
        response.source_status = { SENSOR_PANTAI: await sensorStatus() };
    }
    res.status(200).json(response);
});

module.exports = router;
