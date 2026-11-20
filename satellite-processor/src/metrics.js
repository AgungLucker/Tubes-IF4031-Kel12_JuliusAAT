const client = require("@prometheus-io/client");

const register = new client.Registry();
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
    registers: [register],
});

const lateRejectedTotal = new client.Counter({
    name: "satellite_late_rejected_total",
    help: "Detections rejected for exceeding the lateness limit",
    registers: [register],
});

const commitLatencySeconds = new client.Histogram({
    name: "satellite_commit_latency_seconds",
    help: "Time from event received to batch commit",
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
    registers: [register],
});


function registerGauges({ getStats, getFeedHeadOffset }) {
    new client.Gauge({
        name: "satellite_committed_offset",
        help: "Last feed offset committed to the database",
        registers: [register],
        collect() {
            this.set(getStats().committedOffset);
        },
    });

    new client.Gauge({
        name: "satellite_feed_lag",
        help: "Feed head offset minus last committed offset",
        registers: [register],
        async collect() {
            const head = await getFeedHeadOffset();
            if (head !== null) this.set(head - getStats().committedOffset);
        },
    });
}

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

module.exports = {
    httpMetrics,
    metricsHandler,
    registerGauges,
    lateRejectedTotal,
    commitLatencySeconds,
};