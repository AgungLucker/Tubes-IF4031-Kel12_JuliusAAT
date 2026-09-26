const express = require("express");

const healthRouter = require("./routes/health");
const hazardEventsRouter = require("./routes/hazardEvents")
const { startPoller } = require("./ingest/poller");

const app = express();

app.use(express.json());

app.use("/health", healthRouter);
app.use("/hazard-events", hazardEventsRouter)

const PORT = process.env.PORT || 8090;

app.listen(PORT, () => {
    console.log(`Aggregator service running on port ${PORT}`);
    startPoller();
});