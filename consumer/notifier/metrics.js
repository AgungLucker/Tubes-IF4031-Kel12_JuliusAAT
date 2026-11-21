const client = require("@prometheus-io/client");

const register = new client.Registry();
register.setDefaultLabels({ service: "consumer-notifier", pod: process.env.HOSTNAME || "local" });
client.collectDefaultMetrics({ register });

const messagesTotal = new client.Counter({
    name: "consumer_messages_total",
    help: "Messages consumed from the queue",
    labelNames: ["queue", "severity", "result"],
    registers: [register],
});

const alertLatency = new client.Histogram({
    name: "notifier_alert_latency_seconds",
    help: "Time from publish (aggregator) until the alert is sent",
    labelNames: ["severity"],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 3, 4, 5, 7.5, 10, 30, 60],
    registers: [register],
});

const redeliveredTotal = new client.Counter({
    name: "consumer_redelivered_total",
    help: "Messages delivered again by the broker (consumer died before ack)",
    labelNames: ["queue"],
    registers: [register],
});

const brokerConnected = new client.Gauge({
    name: "consumer_broker_connected",
    help: "1 if connected to RabbitMQ, else 0",
    registers: [register],
});

async function handleMetrics(res) {
    res.setHeader("content-type", register.contentType);
    res.end(await register.metrics());
}

module.exports = { register, messagesTotal, alertLatency, redeliveredTotal, brokerConnected, handleMetrics };
