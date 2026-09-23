const express = require('express');
const pool = require('../db/connection');
const { getOutageStatus } = require('./adminOutage');
const { getConfidenceLevel } = require('./adminSchemaVersion');

const router = express.Router();

router.get('/', async (req, res) => {
  if (getOutageStatus()) {
    return res.status(503).json({ error: 'PVMBG service unavailable (outage)' });
  }

  const since = req.query.since || new Date(0).toISOString();

  try {
    const result = await pool.query(
      `SELECT *
         FROM volcanic_reports
        WHERE reported_at >= $1
        ORDER BY reported_at ASC`,
      [since]
    );

    const reports = result.rows.map((row) => {
      const report = {
        report_id: row.report_id,
        volcano_id: row.volcano_id,
        alert_level: row.alert_level,
        eruption_count_24h: row.eruption_count_24h,
        ash_column_height_m: row.ash_column_height_m,
        reported_at: row.reported_at,
      };

      if (getConfidenceLevel()) {
        report.confidence_level = row.confidence_level;
      }

      return report;
    });

    res.json(reports);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;