const client = require("@prometheus-io/client");

const register = new client.Registry();
register.setDefaultLabels({ service: "aggregator", pod: process.env.HOSTNAME || "local" });
client.collectDefaultMetrics({ register });

const httpRequests = new client.Counter({
    name: "http_requests_total",
    help: "Total HTTP requests",
    labelNames: ["method", "route", "status"],
    registers: [register],
});

const httpDuration = new client.Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30],
    registers: [register],
});


const pollDuration = new client.Histogram({
    name: "aggregator_poll_duration_seconds",
    help: "Duration of one poll cycle per source",
    labelNames: ["source"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [register],
});

const pollTotal = new client.Counter({
    name: "aggregator_poll_total",
    help: "Poll cycles per source and result (success|error)",
    labelNames: ["source", "result"],
    registers: [register],
});

const lastSuccessfulPollTimestamp = new client.Gauge({
    name: "aggregator_last_successful_poll_timestamp_seconds",
    help: "Unix timestamp of the last successful poll per source",
    labelNames: ["source"],
    registers: [register],
});

const isLeader = new client.Gauge({
    name: "aggregator_is_leader",
    help: "1 if this instance currently holds the lease for the source, else 0",
    labelNames: ["source"],
    registers: [register],
});

const leaseEpoch = new client.Gauge({
    name: "aggregator_lease_epoch",
    help: "Lease epoch (fencing token) held by this instance for the source",
    labelNames: ["source"],
    registers: [register],
});

const fencedWritesTotal = new client.Counter({
    name: "aggregator_fenced_writes_total",
    help: "Writes rejected because this instance's epoch was stale (zombie leader)",
    labelNames: ["source"],
    registers: [register],
});

// ---- Shards & readiness (dibaca dari lifecycle saat scrape) ----
// require di dalam collect() agar tidak ada circular require saat modul dimuat.
new client.Gauge({
    name: "aggregator_shards_online",
    help: "Number of HazardEvent shards reachable from this instance",
    registers: [register],
    collect() { this.set(require("./lifecycle").state.shardsUp); },
});

new client.Gauge({
    name: "aggregator_shards_total",
    help: "Number of configured HazardEvent shards",
    registers: [register],
    collect() { this.set(require("./lifecycle").state.shardsTotal); },
});


const rejectedMessagesTotal = new client.Counter({
    name: "aggregator_rejected_messages_total",
    help: "Messages stored as rejected, per source and retryable",
    labelNames: ["source", "retryable"],
    registers: [register],
});


const fieldReportsTotal = new client.Counter({
    name: "aggregator_field_reports_total",
    help: "Field reports consumed, per result (stored|duplicate|failed)",
    labelNames: ["result"],
    registers: [register],
});

function httpMetrics(req, res, next) {
    const end = httpDuration.startTimer();
    res.on("finish", () => {
        const route = req.route ? req.baseUrl + req.route.path : "unmatched";
        httpRequests.inc({ method: req.method, route, status: res.statusCode });
        end({ method: req.method, route });
    });
    next();
}

async function metricsHandler(req, res) {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
}


// ---- Generic helpers (Sensor Pantai / critical-alert path) -----------------------------------
// Metrics are created on first use in the same registry, so they appear at /metrics next to the
// rest. A given metric name must always be used with the same label names.
const dynamic = new Map();
function dyn(kind, name, labels, extra = {}) {
    let m = dynamic.get(name);
    if (!m) {
        const Ctor = { counter: client.Counter, gauge: client.Gauge, histogram: client.Histogram }[kind];
        m = new Ctor({ name, help: name, labelNames: Object.keys(labels), registers: [register], ...extra });
        dynamic.set(name, m);
    }
    return m;
}
const inc = (name, labels = {}, by = 1) => dyn("counter", name, labels).inc(labels, by);
const setGauge = (name, value, labels = {}) => dyn("gauge", name, labels).set(labels, value);
const observe = (name, seconds, labels = {}) =>
    dyn("histogram", name, labels, { buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10] }).observe(labels, seconds);

module.exports = {
    inc,
    setGauge,
    observe,
    register,
    httpMetrics,
    metricsHandler,
    pollDuration,
    pollTotal,
    lastSuccessfulPollTimestamp,
    isLeader,
    leaseEpoch,
    fencedWritesTotal,
    rejectedMessagesTotal,
    fieldReportsTotal,
};
