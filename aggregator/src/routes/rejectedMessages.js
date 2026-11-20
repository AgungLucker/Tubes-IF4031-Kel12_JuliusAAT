const express = require("express");
const { SOURCES } = require("../store/canonicalStore");
const { CursorError } = require("../store/cursor");
const { listUnprocessed } = require("../store/unprocessedStore");

const router = express.Router();

router.get("/", async (req, res) => {
    const { source, cursor } = req.query;
    if (source && !SOURCES.includes(source)) {
        return res.status(400).json({ error: { code: "bad_request", message: "source tidak dikenal" } });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

    try {
        const page = await listUnprocessed({ source, limit, cursor });
        res.status(200).json({ items: page.items, next_cursor: page.next_cursor });
    } catch (err) {
        if (err instanceof CursorError) {
            return res.status(400).json({ error: { code: "bad_request", message: err.message } });
        }

        console.error(err);
        res.status(503).json({ error: { code: "unavailable", message: "penyimpanan pesan gagal tidak tersedia" } });
    }
});

module.exports = router;