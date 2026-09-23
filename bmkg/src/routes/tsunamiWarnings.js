const express = require("express");
const pool = require("../db/connection");

const router = express.Router();

router.get("/", async (req, res) => {
    try {
        const since = req.query.since || new Date(0).toISOString();

        const result = await pool.query(
            `SELECT
                tw.*
            FROM tsunami_warnings AS tw
            JOIN seismic_events AS se
                ON tw.related_event_id = se.event_id
            WHERE se.occurred_at >= $1
            ORDER BY se.occurred_at ASC`,
            [since]
        );

        res.json(result.rows);
    }

    catch (error) {
        console.error(error);
        res.status(500).json({
            error: "Internal server error"
        });
    }
})

module.exports = router;