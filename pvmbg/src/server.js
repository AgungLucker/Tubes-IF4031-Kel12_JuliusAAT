const express = require("express");

const healthRouter = require("./routes/health");
const volcanicReportsRouter = require("./routes/volcanicReports");
const { router: adminSchemaVersionRouter } = require("./routes/adminSchemaVersion");
const { router: adminOutageRouter } = require("./routes/adminOutage");
const authenticateToken = require("./middleware/authenticateToken");
const isCurrentlyOutage = require("./middleware/outage")
const scheduleSeeder = require("./seeders/seedingSchedulers");

const app = express();

app.use(express.json());

app.use("/health", isCurrentlyOutage, healthRouter);
app.use("/volcanic-reports", isCurrentlyOutage, authenticateToken, volcanicReportsRouter);
app.use("/admin/schema-version", isCurrentlyOutage, authenticateToken, adminSchemaVersionRouter);
app.use("/admin/outage", authenticateToken ,adminOutageRouter);

const PORT = process.env.PORT || 8082;

app.listen(PORT, () => {
    console.log(`PVMBG mock running on port ${PORT}`);
});

scheduleSeeder();