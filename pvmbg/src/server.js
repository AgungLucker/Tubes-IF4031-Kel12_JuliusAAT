const express = require("express");

const healthRouter = require("./routes/health");
const volcanicReportsRouter = require("./routes/volcanicReports");
const { router: adminSchemaVersionRouter } = require("./routes/adminSchemaVersion");
const { router: adminOutageRouter } = require("./routes/adminOutage");

const app = express();

app.use(express.json());

app.use("/health", healthRouter);
app.use("/volcanic-reports", volcanicReportsRouter);
app.use("/admin/schema-version", adminSchemaVersionRouter);
app.use("/admin/outage", adminOutageRouter);

const PORT = process.env.PORT || 8082;

app.listen(PORT, () => {
    console.log(`PVMBG mock running on port ${PORT}`);
});