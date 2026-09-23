const express = require("express");
const router = express.Router();

let outage = false;

router.post("/", async (req, res) => {
    const newOutage = req.body.outage;

    if (typeof newOutage !== 'boolean') {
        return res.status(400).json({ error: '"outage" harus bertipe boolean' });
    }
    
    outage = newOutage;

    res.status(200).json({
        status: "ok"
    });
});

module.exports = {
    router,
    getOutageStatus: () => outage
};