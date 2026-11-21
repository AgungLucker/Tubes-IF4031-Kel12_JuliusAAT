const express = require("express");
const rateLimit = require("express-rate-limit");
const { randomUUID } = require("crypto")

const healthRouter = require("./routes/health");
const hazardEventsRouter = require("./routes/hazardEvents");
const rejectedMessagesRouter = require("./routes/rejectedMessages");
const auditRouter = require("./routes/audit");
const analyticsRouter = require("./routes/analytics");
const { startMigrationLoop } = require("./db/migrate");
const { startPoller, stopPoller } = require("./ingest/poller");
const { state, startShardMonitor } = require("./lifecycle");
const { startPublisher } = require("./broker/publisher");
const { runWithRetry: startFieldReportConsumer } = require("./consumer/consume");
const { log } = require("./logger")
const metrics = require("./metrics");

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
app.get("/metrics", (req, res) => res.type("text/plain; version=0.0.4").send(metrics.render()));

const limiter = rateLimit({
    windowMs: 1000,
    max: Number(process.env.RATE_LIMIT_PER_SEC || 100),
    skip: (req) => req.get("X-Client-Priority") === "high",
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" }
});
app.use("/hazard-events", limiter, hazardEventsRouter)
app.use("/rejected-messages", limiter, rejectedMessagesRouter)
app.use("/internal/audit", auditRouter);
app.use("/analytics", analyticsRouter);

const PORT = process.env.PORT || 8090;

process.on("unhandledRejection", (err) => {
    log.error({ event: "unhandled_rejection", error: err?.message || String(err) });
});

const server = app.listen(PORT, async () => {
    console.log(`Aggregator service running on port ${PORT}`);
    startShardMonitor();
    await startMigrationLoop();
    state.started = true;
    if (process.env.DISABLE_POLLER !== "true") startPoller();
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

// Graceful shutdown
//   1. stop being "ready" 
//   2. give the leases back 
//   3. keep serving for a moment 
const DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS || 3000);
const FORCE_EXIT_MS = Number(process.env.SHUTDOWN_FORCE_MS || 25000);
let shuttingDown = false;

async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    state.draining = true;
    log.info({ event: "shutdown_begin", signal });
    setTimeout(() => process.exit(1), FORCE_EXIT_MS).unref();

    await stopPoller().catch(() => { });
    await new Promise((r) => setTimeout(r, DRAIN_MS));
    server.close(() => {
        log.info({ event: "shutdown_done" });
        process.exit(0);
    });
    server.closeIdleConnections?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("message", (msg) => { if (msg === "shutdown") shutdown("IPC"); });