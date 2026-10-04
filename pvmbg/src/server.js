const express = require("express");
const { log } = require("./logger");
const { randomUUID } = require("crypto");

const healthRouter = require("./routes/health");
const volcanicReportsRouter = require("./routes/volcanicReports");
const { router: adminSchemaVersionRouter } = require("./routes/adminSchemaVersion");
const { router: adminOutageRouter } = require("./routes/adminOutage");
const authenticateToken = require("./middleware/authenticateToken");
const isCurrentlyOutage = require("./middleware/outage")
const scheduleSeeder = require("./seeders/seedingSchedulers");
const pvmbgDelay = require("./middleware/pvmbgDelay");

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

app.use("/health", isCurrentlyOutage, pvmbgDelay, healthRouter);
app.use("/volcanic-reports", isCurrentlyOutage, pvmbgDelay, authenticateToken, volcanicReportsRouter);
app.use("/admin/schema-version", isCurrentlyOutage, pvmbgDelay, authenticateToken, adminSchemaVersionRouter);
app.use("/admin/outage", pvmbgDelay, authenticateToken ,adminOutageRouter);

const PORT = process.env.PORT || 8082;

app.listen(PORT, () => {
    console.log(`PVMBG mock running on port ${PORT}`);
});

scheduleSeeder();