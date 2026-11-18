const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");

const store = require("../store/canonicalStore");
const { CursorError } = require("../store/cursor");
const { listUnprocessed } = require("../store/unprocessedStore");
const { locateShard } = require("../k8s/podLocator");

const router = express.Router();

function sendError(res, status, code, message) {
    res.status(status).json({ error: { code, message } });
}


function safeEqual(a, b) {
    const ha = crypto.createHash("sha256").update(a).digest();
    const hb = crypto.createHash("sha256").update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

function requireAuditToken(req, res, next) {
    const expected = process.env.AUDIT_TOKEN;
    if (!expected) return sendError(res, 503, "unavailable", "audit token belum dikonfigurasi");

    const header = req.get("Authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) return sendError(res, 401, "unauthorized", "token tidak ada");
    if (!safeEqual(match[1].trim(), expected)) return sendError(res, 401, "unauthorized", "token tidak valid");
    next();
}

router.use(requireAuditToken);
router.use(
    rateLimit({
        windowMs: 1000,
        limit: Number(process.env.AUDIT_RATE_LIMIT_PER_SEC || 50),
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => sendError(res, 429, "rate_limited", "terlalu banyak permintaan"),
    })
);


class BadRequest extends Error {}

function parseSource(raw, { required = false } = {}) {
    if (raw === undefined || raw === "") {
        if (required) throw new BadRequest("parameter source wajib diisi");
        return undefined;
    }
    if (!store.SOURCES.includes(raw)) throw new BadRequest(`source tidak dikenal: ${raw}`);
    return raw;
}

function parseLimit(raw, def = 100, max = 1000) {
    if (raw === undefined || raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new BadRequest("limit harus bilangan bulat >= 1");
    return Math.min(n, max);
}

function parseTime(raw, name) {
    if (raw === undefined || raw === "") return undefined;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) throw new BadRequest(`${name} harus waktu ISO 8601`);
    return d.toISOString();
}


router.get("/events", async (req, res) => {
    const result = await store.listEvents({
        source: parseSource(req.query.source),
        since: parseTime(req.query.since, "since"),
        limit: parseLimit(req.query.limit),
        cursor: req.query.cursor,
    });
    res.json(result);
});

router.get("/checksum", async (req, res) => {
    res.json(await store.checksum(parseSource(req.query.source, { required: true })));
});

router.get("/location", async (req, res) => {
    const hazardId = req.query.hazard_id;
    if (!hazardId) throw new BadRequest("parameter hazard_id wajib diisi");
    if (!/^hz-[0-9a-f]{16}$/.test(hazardId)) {
        return sendError(res, 404, "not_found", "hazard_id tidak ditemukan");
    }

    const { found, shard } = await store.findHazardEvent(hazardId);
    if (found === false) return sendError(res, 404, "not_found", "hazard_id tidak ditemukan");

    const { available, locations } = await locateShard(shard);
    res.json({ hazard_id: hazardId, locations, partial: found === null || !available });
});

router.get("/unprocessed", async (req, res) => {
    const result = await listUnprocessed({
        source: parseSource(req.query.source),
        limit: parseLimit(req.query.limit),
        cursor: req.query.cursor,
    });
    res.json({ items: result.items, next_cursor: result.next_cursor ?? null });
});

router.use((_req, res) => sendError(res, 404, "not_found", "endpoint tidak ditemukan"));

router.use((err, req, res, _next) => {
    if (err instanceof BadRequest || err instanceof CursorError) {
        return sendError(res, 400, "bad_request", err.message);
    }
    console.error(JSON.stringify({ event: "audit_error", correlation_id: req.cid, path: req.originalUrl, error: err.message }));
    sendError(res, 503, "unavailable", "penyimpanan sementara tidak dapat melayani permintaan");
});

module.exports = router;
