const express = require("express");

const authenticateApiKey = require("./middleware/authenticateApiKey")
const seismicEventsRouter = require("./routes/seismicEvents");
const tsunamiWarningsRouter = require("./routes/tsunamiWarnings");
const healthRouter = require("./routes/health");
const scheduleSeeder = require('./seeders/seedingScheduler');
const bmkgDelay = require("./middleware/bmkgDelay");

const app = express();
const { log } = require("./logger");
const { randomUUID } = require("crypto");

app.use(express.json());


app.use((req, res, next) => {
    req.cid = req.get("X-Correlation-ID") || randomUUID();
    res.set("X-Correlation-ID", req.cid);
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        log.info({
            event: "request",
            correlation_id: req.cid,
            method: req.method,
            path: req.originalUrl,
            status: res.statusCode,
            latency_ms: Number(process.hrtime.bigint() - start) / 1e6,
        });
    });
    next();
});

app.use("/health", bmkgDelay, healthRouter);
app.use("/seismic-events", bmkgDelay, authenticateApiKey, seismicEventsRouter);
app.use("/tsunami-warnings", bmkgDelay, authenticateApiKey, tsunamiWarningsRouter);

const PORT = 8081;

app.listen(PORT, () => {
    console.log(`BMKG service running on port ${PORT}`);
});

scheduleSeeder();