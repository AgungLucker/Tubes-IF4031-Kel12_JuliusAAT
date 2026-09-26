const express = require("express");

const authenticateApiKey = require("./middleware/authenticateApiKey")
const seismicEventsRouter = require("./routes/seismicEvents");
const tsunamiWarningsRouter = require("./routes/tsunamiWarnings");
const healthRouter = require("./routes/health");
const scheduleSeeder = require('./seeders/seedingScheduler');
const bmkgDelay = require("./middleware/bmkgDelay");

const app = express();

app.use(express.json());

app.use("/health", bmkgDelay, healthRouter);
app.use("/seismic-events", bmkgDelay, authenticateApiKey, seismicEventsRouter);
app.use("/tsunami-warnings", bmkgDelay, authenticateApiKey, tsunamiWarningsRouter);

const PORT = 8081;

app.listen(PORT, () => {
    console.log(`BMKG service running on port ${PORT}`);
});

scheduleSeeder();