const crypto = require("crypto");
const { makeHazardId, bucketOf, shardFor, bucketRanges } = require("../db/router");
const { scatter } = require("../db/scatter");
const { encodeCursor, decodeCursor } = require("./cursor");
const { withFence } = require("../coordination/fence");

const WRITE_TIMEOUT_MS = Number(process.env.SHARD_WRITE_TIMEOUT_MS || 3000);
const AUDIT_TIMEOUT_MS = Number(process.env.SHARD_AUDIT_TIMEOUT_MS || 20000);

const SOURCES = ["BMKG", "PVMBG", "SATELIT", "SENSOR_PANTAI"];
const HAZARD_TYPES = ["SEISMIC", "TSUNAMI", "VOLCANIC", "WILDFIRE", "COASTAL"];
const SEVERITIES = ["NORMAL", "WASPADA", "SIAGA", "AWAS"];

// Field persis seperti kontrak Audit API (bucket/updated_at adalah detail internal).
const COLUMNS = `hazard_id, source, source_ref_id, hazard_type, severity, area_name,
    latitude, longitude, occurred_at, ingested_at, attributes`;

// Representasi teks presisi mikrodetik, dipakai sebagai kunci urut & isi cursor
// (Date JavaScript hanya presisi milidetik).
const tsKey = (col) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- tulis

// Upsert idempoten: data yang sama diproses berulang -> tetap satu baris, dan bila
// isinya tidak berubah, baris tidak disentuh sama sekali (tidak ada WAL/updated_at baru).
// Mengembalikan { hazard_id, shard, inserted, changed }.
//
// fence = { source, epoch } (token milik leader polling): bila diberikan, tulis hanya
// berhasil jika epoch itu belum disalip leader yang lebih baru di shard tsb; selain itu
// dilempar FencedError dan tidak ada yang tersimpan. Tanpa fence (mis. field report) tulis biasa.
async function upsertHazardEvent(event, fence = null) {
    const {
        source, source_ref_id, hazard_type, severity, area_name,
        latitude, longitude, occurred_at, attributes,
    } = event;

    const refId = String(source_ref_id);
    const hazard_id = makeHazardId(source, refId);
    const bucket = bucketOf(hazard_id);
    const shard = shardFor(hazard_id);

    const result = await withFence(shard.pool, fence, (db) => db.query({
        text: `INSERT INTO hazard_events (
                hazard_id, bucket, source, source_ref_id, hazard_type,
                severity, area_name, latitude, longitude, occurred_at, attributes
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT (source, source_ref_id) DO UPDATE SET
                hazard_type = EXCLUDED.hazard_type,
                severity    = EXCLUDED.severity,
                area_name   = EXCLUDED.area_name,
                latitude    = EXCLUDED.latitude,
                longitude   = EXCLUDED.longitude,
                occurred_at = EXCLUDED.occurred_at,
                attributes  = EXCLUDED.attributes,
                updated_at  = now()
            WHERE (hazard_events.hazard_type, hazard_events.severity, hazard_events.area_name,
                   hazard_events.latitude, hazard_events.longitude, hazard_events.occurred_at,
                   hazard_events.attributes)
                IS DISTINCT FROM
                  (EXCLUDED.hazard_type, EXCLUDED.severity, EXCLUDED.area_name,
                   EXCLUDED.latitude, EXCLUDED.longitude, EXCLUDED.occurred_at,
                   EXCLUDED.attributes)
            RETURNING (xmax = 0) AS inserted`,
        values: [hazard_id, bucket, source, refId, hazard_type, severity,
            area_name, latitude, longitude, occurred_at, JSON.stringify(attributes ?? {})],
        query_timeout: WRITE_TIMEOUT_MS,
    }));

    const row = result.rows[0];
    return { hazard_id, shard: shard.name, inserted: row?.inserted === true, changed: Boolean(row) };
}

// Menghapus satu HazardEvent (dipakai mis. kebakaran yang ditarik). true bila ada yang terhapus.
async function deleteHazardEvent(source, sourceRefId, fence = null) {
    const hazard_id = makeHazardId(source, String(sourceRefId));
    const shard = shardFor(hazard_id);
    const res = await withFence(shard.pool, fence, (db) => db.query({
        text: "DELETE FROM hazard_events WHERE hazard_id = $1",
        values: [hazard_id],
        query_timeout: WRITE_TIMEOUT_MS,
    }));
    return res.rowCount > 0;
}

// ---------------------------------------------------------------- baca: helper

function buildWhere(filters) {
    const conds = [];
    const values = [];
    for (const [sqlTemplate, ...params] of filters) {
        if (params.some((p) => p === undefined || p === null || p === "")) continue;
        const placeholders = params.map((p) => {
            values.push(p);
            return `$${values.length}`;
        });
        conds.push(sqlTemplate.replace(/\?/g, () => placeholders.shift()));
    }
    return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", values };
}

function stripKey(rows) {
    return rows.map(({ _k, ...rest }) => rest);
}

// ---------------------------------------------------------------- baca: N event terbaru

// Event terbaru dulu (occurred_at DESC, hazard_id DESC) dari seluruh shard.
// Setiap shard mengirim limit+1 baris; hasil di-merge lalu dipotong ke limit.
// Bila total baris > limit pasti masih ada halaman berikutnya.
async function listLatest({ hazardType, source, limit = 50, cursor } = {}) {
    const c = decodeCursor(cursor, ["o", "h"]);
    const { where, values } = buildWhere([
        ["hazard_type = ?", hazardType],
        ["source = ?", source],
        ["(occurred_at, hazard_id) < (?::timestamptz, ?)", c?.o, c?.h],
    ]);
    values.push(limit + 1);
    const sql = `SELECT ${COLUMNS}, ${tsKey("occurred_at")} AS _k FROM hazard_events ${where}
        ORDER BY occurred_at DESC, hazard_id DESC LIMIT $${values.length}`;

    const { results, unavailable } = await scatter((_s, q) => q(sql, values));
    const merged = results
        .flatMap((r) => r.value)
        .sort((a, b) => cmp(b._k, a._k) || cmp(b.hazard_id, a.hazard_id));

    const page = merged.slice(0, limit);
    const last = page[page.length - 1];
    return {
        items: stripKey(page),
        next_cursor: merged.length > limit && last ? encodeCursor({ o: last._k, h: last.hazard_id }) : null,
        partial: unavailable.length > 0,
        unavailable_units: unavailable,
    };
}

// ---------------------------------------------------------------- baca: Audit /events

// Urut menaik (ingested_at, hazard_id); since menyaring ingested_at >= since.
async function listEvents({ source, since, limit = 100, cursor } = {}) {
    const c = decodeCursor(cursor, ["i", "h"]);
    const { where, values } = buildWhere([
        ["source = ?", source],
        ["ingested_at >= ?::timestamptz", since],
        ["(ingested_at, hazard_id) > (?::timestamptz, ?)", c?.i, c?.h],
    ]);
    values.push(limit + 1);
    const sql = `SELECT ${COLUMNS}, ${tsKey("ingested_at")} AS _k FROM hazard_events ${where}
        ORDER BY ingested_at, hazard_id LIMIT $${values.length}`;

    const { results, unavailable } = await scatter((_s, q) => q(sql, values), { timeoutMs: AUDIT_TIMEOUT_MS });
    const merged = results
        .flatMap((r) => r.value)
        .sort((a, b) => cmp(a._k, b._k) || cmp(a.hazard_id, b.hazard_id));

    const page = merged.slice(0, limit);
    const last = page[page.length - 1];
    return {
        items: stripKey(page),
        next_cursor: merged.length > limit && last ? encodeCursor({ i: last._k, h: last.hazard_id }) : null,
        partial: unavailable.length > 0,
        unavailable_units: unavailable,
    };
}

// ---------------------------------------------------------------- baca: Audit /checksum

// SHA-256 atas source_ref_id seluruh HazardEvent sumber tsb, urut menaik menurut byte,
// dipisah "\n" tanpa newline di akhir.
async function checksum(source) {
    const sql = "SELECT source_ref_id FROM hazard_events WHERE source = $1 ORDER BY source_ref_id";
    const { results, unavailable } = await scatter((_s, q) => q(sql, [source]), { timeoutMs: AUDIT_TIMEOUT_MS });

    const ids = results.flatMap((r) => r.value.map((row) => Buffer.from(row.source_ref_id, "utf8")));
    ids.sort(Buffer.compare);

    const hash = crypto.createHash("sha256");
    ids.forEach((id, i) => {
        if (i > 0) hash.update("\n");
        hash.update(id);
    });

    return {
        source,
        count: ids.length,
        checksum: hash.digest("hex"),
        algorithm: "sha256",
        as_of: new Date().toISOString(),
        partial: unavailable.length > 0,
        unavailable_units: unavailable,
    };
}

// ---------------------------------------------------------------- baca: satu event

// Mengembalikan { found: bool|null, shard }. found=null bila shard pemilik tak terjangkau.
async function findHazardEvent(hazardId) {
    const shard = shardFor(hazardId);
    const { results } = await scatter(
        (_s, q) => q(`SELECT ${COLUMNS} FROM hazard_events WHERE hazard_id = $1`, [hazardId]),
        { targets: [shard] }
    );
    if (!results.length) return { found: null, shard: shard.name, event: null };
    const event = results[0].value[0] || null;
    return { found: Boolean(event), shard: shard.name, event };
}

// ---------------------------------------------------------------- analitik

const INTERVALS = ["hour", "day", "week", "month", "year"];

// Agregasi lintas shard: tiap shard menghitung GROUP BY lokal, Aggregator menjumlahkan.
// Karena satu HazardEvent hanya ada di satu shard, penjumlahan ini eksak (tidak ada dobel hitung).
async function aggregate({ from, to, interval = "day", hazardType } = {}) {
    const { where, values } = buildWhere([
        ["occurred_at >= ?::timestamptz", from],
        ["occurred_at < ?::timestamptz", to],
        ["hazard_type = ?", hazardType],
    ]);
    const tVal = values.length + 1;
    const queries = {
        series: {
            sql: `SELECT hazard_type, date_trunc($${tVal}, occurred_at, 'UTC') AS t, count(*)::bigint AS n
                  FROM hazard_events ${where} GROUP BY 1, 2`,
            values: [...values, interval],
        },
        bySeverity: {
            sql: `SELECT hazard_type, severity, count(*)::bigint AS n FROM hazard_events ${where} GROUP BY 1, 2`,
            values,
        },
        byArea: {
            sql: `SELECT area_name, hazard_type, count(*)::bigint AS n FROM hazard_events ${where} GROUP BY 1, 2`,
            values,
        },
    };

    const { results, unavailable } = await scatter(
        async (_s, q) => {
            const out = {};
            for (const [k, { sql, values: v }] of Object.entries(queries)) out[k] = await q(sql, v);
            return out;
        },
        { timeoutMs: AUDIT_TIMEOUT_MS }
    );

    const totals = Object.fromEntries(HAZARD_TYPES.map((t) => [t, 0]));
    const severity = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
    const severityByType = {};
    const series = {};
    const areas = {};

    for (const { value } of results) {
        for (const r of value.series) {
            const t = new Date(r.t).toISOString();
            series[r.hazard_type] ??= {};
            series[r.hazard_type][t] = (series[r.hazard_type][t] || 0) + Number(r.n);
            totals[r.hazard_type] = (totals[r.hazard_type] || 0) + Number(r.n);
        }
        for (const r of value.bySeverity) {
            severity[r.severity] = (severity[r.severity] || 0) + Number(r.n);
            severityByType[r.hazard_type] ??= {};
            severityByType[r.hazard_type][r.severity] = (severityByType[r.hazard_type][r.severity] || 0) + Number(r.n);
        }
        for (const r of value.byArea) {
            areas[r.area_name] ??= { area_name: r.area_name, total: 0, by_type: {} };
            areas[r.area_name].total += Number(r.n);
            areas[r.area_name].by_type[r.hazard_type] = (areas[r.area_name].by_type[r.hazard_type] || 0) + Number(r.n);
        }
    }

    return {
        range: { from: from || null, to: to || null, interval },
        total: Object.values(totals).reduce((a, b) => a + b, 0),
        by_hazard_type: totals,
        by_severity: severity,
        severity_by_hazard_type: severityByType,
        series: Object.fromEntries(
            Object.entries(series).map(([type, pts]) => [
                type,
                Object.entries(pts).sort(([a], [b]) => cmp(a, b)).map(([t, n]) => ({ t, n })),
            ])
        ),
        by_area: Object.values(areas).sort((a, b) => b.total - a.total || cmp(a.area_name, b.area_name)),
        as_of: new Date().toISOString(),
        partial: unavailable.length > 0,
        unavailable_units: unavailable,
    };
}

// Sebaran data & beban tulis per shard (bukti kriteria P1 #1).
async function distribution() {
    const { results, unavailable } = await scatter(
        async (_s, q) => {
            const [count] = await q("SELECT count(*)::bigint AS n FROM hazard_events");
            const bySource = await q("SELECT source, count(*)::bigint AS n FROM hazard_events GROUP BY 1 ORDER BY 1");
            const buckets = await q("SELECT bucket, count(*)::bigint AS n FROM hazard_events GROUP BY 1 ORDER BY 1");
            const [stat] = await q(`SELECT n_tup_ins::bigint AS inserts, n_tup_upd::bigint AS updates,
                    n_live_tup::bigint AS live_rows, pg_total_relation_size('hazard_events')::bigint AS table_bytes,
                    pg_is_in_recovery() AS served_by_replica
                FROM pg_stat_user_tables WHERE relname = 'hazard_events'`);
            return { count, bySource, buckets, stat };
        },
        { timeoutMs: AUDIT_TIMEOUT_MS }
    );

    const ranges = Object.fromEntries(bucketRanges().map((r) => [r.shard, r.buckets]));
    const units = results.map(({ shard, value, via }) => ({
        unit: shard,
        bucket_range: ranges[shard],
        rows: Number(value.count?.n || 0),
        by_source: Object.fromEntries(value.bySource.map((r) => [r.source, Number(r.n)])),
        by_bucket: Object.fromEntries(value.buckets.map((r) => [r.bucket, Number(r.n)])),
        // pg_stat_* dihitung per instance dan reset saat failover; dipakai untuk melihat beban tulis.
        inserts: Number(value.stat?.inserts || 0),
        updates: Number(value.stat?.updates || 0),
        table_bytes: Number(value.stat?.table_bytes || 0),
        read_via: via,
    }));
    const total = units.reduce((a, u) => a + u.rows, 0);
    units.forEach((u) => (u.share = total ? Number((u.rows / total).toFixed(4)) : 0));

    return {
        total,
        units,
        as_of: new Date().toISOString(),
        partial: unavailable.length > 0,
        unavailable_units: unavailable,
    };
}

module.exports = {
    SOURCES,
    HAZARD_TYPES,
    SEVERITIES,
    INTERVALS,
    upsertHazardEvent,
    deleteHazardEvent,
    listLatest,
    listEvents,
    checksum,
    findHazardEvent,
    aggregate,
    distribution,
};
