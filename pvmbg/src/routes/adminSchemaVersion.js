const express = require("express");
const router = express.Router();

let confidence_level = false;

router.post("/", async (req, res) => {
    const newConfidenceLvl = req.body.confidence;

    if (typeof newConfidenceLvl !== 'boolean') {
        return res.status(400).json({ error: '"outage" harus bertipe boolean' });
    }

    confidence_level = newConfidenceLvl;

    res.status(200).json({
        status: "ok"
    });
});

module.exports = {
    router,
    getConfidenceLevel: () => confidence_level
};