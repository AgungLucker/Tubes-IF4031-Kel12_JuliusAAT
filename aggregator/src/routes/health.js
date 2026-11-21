const crypto = require("crypto");
const express = require("express");
const { state, readiness } = require("../lifecycle");

const router = express.Router();

// Liveness: the process is up and its event loop answers. Kubernetes restarts it if this fails.
router.get("/", (req, res) => {
    res.status(200).json({
        status: "ok",
        service: "aggregator"
    })
})

// Readiness
router.get("/ready", (req, res) => {
    const r = readiness();
    res.status(r.ready ? 200 : 503).json({ status: r.ready ? "ready" : "unready", ...r });
});

const safeEqual = (a, b) =>
    crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());

function requireToken(req, res, next) {
    const expected = process.env.AUDIT_TOKEN;
    const m = /^Bearer\s+(.+)$/i.exec(req.get("Authorization") || "");
    if (!expected || !m || !safeEqual(m[1].trim(), expected)) return res.status(401).json({ error: "unauthorized" });
    next();
}

router.post("/force-unready", requireToken, (req, res) => {
    state.forcedUnready = true;
    res.json({ forcedUnready: true, ...readiness() });
});

router.post("/force-ready", requireToken, (req, res) => {
    state.forcedUnready = false;
    res.json({ forcedUnready: false, ...readiness() });
});

module.exports = router;
