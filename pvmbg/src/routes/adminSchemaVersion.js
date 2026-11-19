const express = require("express");
const router = express.Router();

const BREAKING_MODES = ["none", "rename", "type_change", "drop_required"];
const REPORT_FIELDS = ["report_id", "volcano_id", "alert_level", "eruption_count_24h", "ash_column_height_m", "reported_at"];
const VALUE_TYPES = ["string", "number", "boolean"];

let confidence_level = false;
let breaking = { mode: "none" };

router.post("/", async (req, res) => {
    const { confidence, breaking: mode, field, to } = req.body;

    if (confidence !== undefined && typeof confidence !== 'boolean') {
        return res.status(400).json({ error: '"confidence" harus bertipe boolean' });
    }

    if (mode !== undefined) {
        if (!BREAKING_MODES.includes(mode)) {
            return res.status(400).json({ error: `"breaking" harus salah satu dari: ${BREAKING_MODES.join(", ")}` });
        }
        if (mode !== "none" && !REPORT_FIELDS.includes(field)) {
            return res.status(400).json({ error: `"field" harus salah satu dari: ${REPORT_FIELDS.join(", ")}` });
        }
        if (mode === "rename" && (typeof to !== "string" || to === "")) {
            return res.status(400).json({ error: '"to" wajib berupa string untuk mode rename' });
        }
        if (mode === "type_change" && !VALUE_TYPES.includes(to)) {
            return res.status(400).json({ error: `"to" harus salah satu dari: ${VALUE_TYPES.join(", ")}` });
        }
    }

    if (confidence !== undefined) confidence_level = confidence;
    if (mode !== undefined) breaking = { mode, field, to };


    res.status(200).json({
        status: "ok"
    });
});

module.exports = {
    router,
    getConfidenceLevel: () => confidence_level,
    getBreaking: () => breaking
};