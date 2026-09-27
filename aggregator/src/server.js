const express = require("express");
const rateLimit = require("express-rate-limit");

const healthRouter = require("./routes/health");
const hazardEventsRouter = require("./routes/hazardEvents")
const { startPoller } = require("./ingest/poller");

const app = express();

app.use(express.json());

app.use("/health", healthRouter)

const limiter = rateLimit({
    windowMs: 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" }
});
app.use("/hazard-events", limiter, hazardEventsRouter)

const PORT = process.env.PORT || 8090;

app.listen(PORT, () => {
    console.log(`Aggregator service running on port ${PORT}`);
    startPoller();
});