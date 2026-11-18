const express = require("express");
const { randomUUID } = require("crypto");

const authenticateApiKey = require("./middleware/authenticateApiKey");
const firesRouter = require("./routes/fires");
const healthRouter = require("./routes/health");

const { startFeedConsumer } = require("./feed/streamClient");
const { startEventProcessor, handleFeedEvent, getResumeOffset } = require("./processing/eventProcessor");

const { log } = require("./logger");

const app = express()

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
app.use("/fires", authenticateApiKey, firesRouter);

const PORT = process.env.PORT || 8083;

app.listen(PORT, () => {
    console.log(`Satellite processor running on port ${PORT}`);
});

startEventProcessor()
    .then(() => startFeedConsumer({ getLastOffset: getResumeOffset, onEvent: handleFeedEvent }))
    .catch((error) => {
        log.error({ event: "processor_startup_failed", message: error.message });
        process.exit(1);
    });

