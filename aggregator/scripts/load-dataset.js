
const fs = require("fs");
const crypto = require("crypto");
const { upsertHazardEvent } = require("../src/store/canonicalStore");
const { shardFor, makeHazardId, bucketRanges } = require("../src/db/router");
const shards = require("../src/db/shards");

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i].startsWith("--")) args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
        else args._.push(argv[i]);
    }
    return args;
}

function parseCsv(text) {
    const firstLine = text.slice(0, text.indexOf("\n"));
    const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
    const rows = [];
    let row = [], field = "", q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') q = false;
            else field += c;
        } else if (c === '"') q = true;
        else if (c === delim) { row.push(field); field = ""; }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") i++;
            row.push(field); field = "";
            if (row.some((f) => f !== "")) rows.push(row);
            row = [];
        } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    const header = rows.shift().map((h) => h.trim());
    return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]?.trim()])));
}

function readRecords(file) {
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    if (/\.json$/i.test(file)) {
        const data = JSON.parse(text);
        return Array.isArray(data) ? data : data.items || data.data || data.features?.map((f) => ({ ...f.properties, longitude: f.geometry?.coordinates?.[0], latitude: f.geometry?.coordinates?.[1] })) || [];
    }
    if (/\.jsonl$/i.test(file)) return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return parseCsv(text);
}

function pick(rec, names) {
    const keys = Object.keys(rec);
    for (const n of names) {
        const k = keys.find((x) => x.toLowerCase() === n);
        if (k !== undefined && rec[k] !== undefined && rec[k] !== "") return { key: k, value: rec[k] };
    }
    return { key: null, value: undefined };
}

function severityFromMagnitude(m) {
    if (m >= 6.5) return "SIAGA";
    if (m >= 5.0) return "WASPADA";
    return "NORMAL";
}

function toHazardEvent(rec, source) {
    const used = new Set();
    const get = (names) => { const r = pick(rec, names); if (r.key) used.add(r.key); return r.value; };

    let time = get(["occurred_at", "time", "datetime", "origin_time", "origintime", "tgl_waktu"]);
    if (time === undefined) {
        const d = get(["date", "tanggal", "tgl"]);
        const t = get(["time_utc", "jam", "waktu"]);
        if (d) time = t ? `${d}T${t}` : d;
    }
    const occurred = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(String(time)) ? time : `${time}Z`);
    const lat = Number(get(["latitude", "lat", "lintang"]));
    const lon = Number(get(["longitude", "lon", "long", "lng", "bujur"]));
    const mag = Number(get(["magnitude", "mag", "magnitudo"]));
    const depth = get(["depth_km", "depth", "kedalaman"]);
    const area = get(["region_name", "area_name", "place", "remark", "region", "location", "wilayah", "lokasi"]);
    let id = get(["event_id", "id", "eventid", "source_ref_id"]);

    if (Number.isNaN(occurred.getTime()) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (!id) {
        id = "cat-" + crypto.createHash("sha256").update(`${occurred.toISOString()}|${lat}|${lon}|${mag}`).digest("hex").slice(0, 20);
    }

    const extra = Object.fromEntries(Object.entries(rec).filter(([k]) => !used.has(k)));
    return {
        source,
        source_ref_id: String(id),
        hazard_type: "SEISMIC",
        severity: severityFromMagnitude(Number.isFinite(mag) ? mag : 0),
        area_name: area || "Tidak diketahui",
        latitude: lat,
        longitude: lon,
        occurred_at: occurred.toISOString(),
        attributes: { magnitude: Number.isFinite(mag) ? mag : null, depth_km: depth !== undefined ? Number(depth) : null, dataset: "katalog-historis", ...extra },
    };
}

function spikeEvents(n, { area, lat, lon }) {
    const runId = Date.now().toString(36);
    return Array.from({ length: n }, (_, i) => ({
        source: "BMKG",
        source_ref_id: `spike-${runId}-${i}`,
        hazard_type: "SEISMIC",
        severity: severityFromMagnitude(3 + (i % 40) / 10),
        area_name: area,
        latitude: lat + ((i % 50) - 25) * 0.002,
        longitude: lon + ((i % 37) - 18) * 0.002,
        occurred_at: new Date(Date.now() - (n - i) * 1000).toISOString(),
        attributes: { magnitude: 3 + (i % 40) / 10, simulated_spike: runId },
    }));
}

async function run(events, concurrency) {
    const perShard = Object.fromEntries(shards.map((s) => [s.name, { written: 0, inserted: 0, ms: 0 }]));
    let idx = 0, failed = 0, done = 0;
    const started = Date.now();

    async function worker() {
        while (idx < events.length) {
            const ev = events[idx++];
            const t0 = Date.now();
            for (let attempt = 1; ; attempt++) {
                try {
                    const r = await upsertHazardEvent(ev);
                    const s = perShard[r.shard];
                    s.written++; s.ms += Date.now() - t0; if (r.inserted) s.inserted++;
                    break;
                } catch (err) {
                    if (attempt >= 5) { failed++; console.error(`gagal ${ev.source_ref_id} -> ${shardFor(makeHazardId(ev.source, ev.source_ref_id)).name}: ${err.message}`); break; }
                    await new Promise((r) => setTimeout(r, 500 * attempt)); // failover primary: tunggu lalu coba lagi
                }
            }
            if (++done % 2000 === 0) process.stdout.write(`  ${done}/${events.length}\n`);
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    const secs = (Date.now() - started) / 1000;

    const ranges = Object.fromEntries(bucketRanges().map((r) => [r.shard, r.buckets.join("-")]));
    console.log(`\nSelesai: ${events.length} event dalam ${secs.toFixed(1)} s (${(events.length / secs).toFixed(0)} tulis/s), gagal ${failed}`);
    console.table(Object.fromEntries(Object.entries(perShard).map(([name, s]) => [name, {
        buckets: ranges[name],
        tulis: s.written,
        baru: s.inserted,
        porsi: `${((s.written / Math.max(1, events.length - failed)) * 100).toFixed(1)}%`,
        rata_ms: s.written ? +(s.ms / s.written).toFixed(1) : 0,
    }])));
    return failed;
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    const concurrency = Number(args.concurrency || 32);
    let events;

    if (args.spike) {
        const area = args.area || "Sulawesi Tengah";
        events = spikeEvents(Number(args.spike), { area, lat: Number(args.lat ?? -0.9), lon: Number(args.lon ?? 119.9) });
        console.log(`Simulasi lonjakan: ${events.length} gempa di "${area}" (satu wilayah)`);
    } else {
        const file = args._[0];
        if (!file) { console.error("pakai: load-dataset.js <file> | --spike N"); process.exit(2); }
        const raw = readRecords(file);
        events = raw.map((r) => toHazardEvent(r, args.source || "BMKG")).filter(Boolean);
        console.log(`Dataset ${file}: ${raw.length} baris, ${events.length} valid, ${raw.length - events.length} dilewati`);
        const byArea = {};
        events.forEach((e) => (byArea[e.area_name] = (byArea[e.area_name] || 0) + 1));
        const top = Object.entries(byArea).sort((a, b) => b[1] - a[1]).slice(0, 5);
        console.log("Wilayah terpadat (ketidakmerataan alami):", top.map(([a, n]) => `${a}=${n}`).join(", "));
    }

    const failed = await run(events, concurrency);
    await Promise.all(shards.flatMap((s) => [s.pool.end(), s.readPool?.end()]));
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
