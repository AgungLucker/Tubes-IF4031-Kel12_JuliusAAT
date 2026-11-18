const express = require("express");
const { listFires } = require("../store/satelliteStore");
const { log } = require("../logger");

const router = express.Router();

router.get("/", async (req, res) => {
    const { since } = req.query;
    if (since && Number.isNaN(Date.parse(since))) {
        return res.status(400).json({ error: "Invalid since parameter" });
    }

    try {
        const fires = await listFires({ since });
        res.json(fires);
    } catch (error) {
        log.error({ event: "list_fires_failed", correlation_id: req.cid, message: error.message });
        res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = router;