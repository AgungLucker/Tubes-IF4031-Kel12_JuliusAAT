const path = require("path");
const express = require("express");
const store = require("../store/canonicalStore");
const { listShardInstances } = require("../k8s/podLocator");

const router = express.Router();

function bad(res, message) {
    return res.status(400).json({ error: { code: "bad_request", message } });
}

function parseTime(raw) {
    if (raw === undefined || raw === "") return { ok: true, value: undefined };
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? { ok: false } : { ok: true, value: d.toISOString() };
}

router.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "..", "public", "dashboard.html"));
});

router.get("/summary", async (req, res) => {
    const from = parseTime(req.query.from);
    const to = parseTime(req.query.to);
    if (!from.ok || !to.ok) return bad(res, "from/to harus waktu ISO 8601");
    const interval = req.query.interval || "day";
    if (!store.INTERVALS.includes(interval)) return bad(res, `interval harus salah satu dari ${store.INTERVALS.join(", ")}`);
    const hazardType = req.query.hazard_type || undefined;
    if (hazardType && !store.HAZARD_TYPES.includes(hazardType)) return bad(res, "hazard_type tidak dikenal");

    try {
        res.json(await store.aggregate({ from: from.value, to: to.value, interval, hazardType }));
    } catch (err) {
        console.error(err);
        res.status(503).json({ error: { code: "unavailable", message: "agregasi gagal" } });
    }
});

router.get("/distribution", async (_req, res) => {
    try {
        const [dist, pods] = await Promise.all([store.distribution(), listShardInstances()]);
        for (const u of dist.units) u.instances = pods.byShard[u.unit] || [];
        // Shard yang tak terjangkau tetap ditampilkan agar penempatannya terlihat.
        for (const name of dist.unavailable_units) {
            dist.units.push({ unit: name, rows: null, instances: pods.byShard[name] || [] });
        }
        dist.k8s_available = pods.available;
        res.json(dist);
    } catch (err) {
        console.error(err);
        res.status(503).json({ error: { code: "unavailable", message: "sebaran tidak dapat dihitung" } });
    }
});

module.exports = router;
