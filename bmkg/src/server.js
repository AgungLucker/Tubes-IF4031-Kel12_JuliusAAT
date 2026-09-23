const express = require("express");

const authenticateApiKey = require("./middleware/authenticateApiKey")
const seismicEventsRouter = require("./routes/seismicEvents");
const tsunamiWarningsRouter = require("./routes/tsunamiWarnings");
const healthRouter = require("./routes/health");

const app = express();

app.use(express.json());

app.use("/health", healthRouter);
app.use("/seismic-events", authenticateApiKey, seismicEventsRouter);
app.use("/tsunami-warnings", authenticateApiKey, tsunamiWarningsRouter);

const PORT = 8081;

app.listen(PORT, () => {
    console.log(`BMKG service running on port ${PORT}`);
});