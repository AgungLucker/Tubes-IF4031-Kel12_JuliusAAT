const express = require("express");
const { listHazardEvents, getIngestStatus } = require("../store/canonicalStore");

const router = express.Router();

const STALE_THRESHOLD_MS = Number(process.env.POLL_INTERVAL_MS || 3000) * 2;

router.get("/", async (req, res) => {
    try {
        const { hazard_type: hazardType } = req.query;
        const data = await listHazardEvents({ hazardType });
        const response = { data };

        // asumsi client bisa request semua atau spesifik hazardType event
        const includeVolcanicReport = !hazardType || hazardType === "VOLCANIC";

        if (includeVolcanicReport) {
            const statuses = await getIngestStatus();
            const pvmbgStatus = statuses.find((s) => s.source === "PVMBG");

            if (pvmbgStatus?.last_success_at) {
                const lastSuccessAt = new Date(pvmbgStatus.last_success_at);
                const ageMs = Date.now() - lastSuccessAt.getTime();

                if (ageMs > STALE_THRESHOLD_MS) {
                    response.stale_since = lastSuccessAt.toISOString();
                }
            }
        }

        res.status(200).json(response);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal server error" });
    }
})

module.exports = router;