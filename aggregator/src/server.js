const express = require("express");
const rateLimit = require("express-rate-limit");
const { randomUUID } = require("crypto")

const healthRouter = require("./routes/health");
const hazardEventsRouter = require("./routes/hazardEvents")
const auditRouter = require("./routes/audit");
const analyticsRouter = require("./routes/analytics");
const { startMigrationLoop } = require("./db/migrate");
const { startPoller } = require("./ingest/poller");
const { startPublisher } = require("./broker/publisher");
const { runWithRetry: startFieldReportConsumer } = require("./consumer/consume");
const { log } = require("./logger")

startPublisher();
startFieldReportConsumer();

const app = express();

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

app.use("/health", healthRouter)

const limiter = rateLimit({
    windowMs: 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" }
});
app.use("/hazard-events", limiter, hazardEventsRouter)
app.use("/internal/audit", auditRouter);
app.use("/analytics", analyticsRouter);

const PORT = process.env.PORT || 8090;

process.on("unhandledRejection", (err) => {
    log.error({ event: "unhandled_rejection", error: err?.message || String(err) });
});

app.listen(PORT, async () => {
    console.log(`Aggregator service running on port ${PORT}`);
    await startMigrationLoop();
    if (process.env.DISABLE_POLLER !== "true") startPoller();
});