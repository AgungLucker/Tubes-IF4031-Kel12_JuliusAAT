const express = require("express");
const { listFires } = require("../store/satelliteStore");
const { log } = require("../logger");

const router = express.Router();
const MAX_LIMIT = 200;

router.get("/", async (req, res) => {
    const { since, after_id: afterId } = req.query;
    if (since && Number.isNaN(Date.parse(since))) {
        return res.status(400).json({ error: "Invalid since parameter" });
    }

    if (afterId !== undefined && typeof afterId !== "string") {
        return res.status(400).json({ error: "Invalid after_id parameter" });

    }

    const requested = Number.parseInt(req.query.limit, 10);
    const limit = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), MAX_LIMIT) : MAX_LIMIT;

    try {
        const fires = await listFires({ since, afterId, limit });
        res.json(fires);
    } catch (error) {
        log.error({ event: "list_fires_failed", correlation_id: req.cid, message: error.message });
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;