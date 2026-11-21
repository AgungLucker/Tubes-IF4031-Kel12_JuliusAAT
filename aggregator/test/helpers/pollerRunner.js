// One aggregator "instance" for the multi-process test: only the polling part.
// Configuration comes from the environment set by the test (POD_NAME, DB URLs, upstream URLs).
const { startPoller, stopPoller } = require("../../src/ingest/poller");

startPoller();

process.on("SIGTERM", async () => {
    await stopPoller();
    process.exit(0);
});

setInterval(() => {}, 1 << 30); // keep the process alive
