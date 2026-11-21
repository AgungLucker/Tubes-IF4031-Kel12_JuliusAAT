const amqp = require("amqplib");
const http = require("http");
const metrics = require("./metrics");

const EXCHANGE = "hazard.events";
const QUEUE = process.env.QUEUE_NAME || "notifier";
const BINDINGS = (process.env.BINDINGS || "hazard.*.siaga,hazard.*.awas").split(",");
const DELAY_MS = Number(process.env.NOTIFY_DELAY_MS || 0);
const sent = new Set(); 

const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: QUEUE, ...o }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function start() {
    const conn = await amqp.connect(process.env.RABBITMQ_URL);
    conn.on("close", () => { log({ event: "broker_closed" }); process.exit(1); });
    const ch = await conn.createChannel();
    await ch.assertExchange(EXCHANGE, "topic", { durable: true });
    await ch.assertQueue(QUEUE, { durable: true });
    for (const b of BINDINGS) await ch.bindQueue(QUEUE, EXCHANGE, b.trim());
    await ch.prefetch(1);

    await ch.consume(QUEUE, async (msg) => {
        if (!msg) return;
        const event = JSON.parse(msg.content.toString());
        const key = `${event.hazard_id}:${event.severity}`;
        const cid = msg.properties.headers?.correlation_id;
        const severity = event.severity || "unknown";
        if (msg.fields.redelivered) metrics.redeliveredTotal.inc({ queue: QUEUE });

        if (sent.has(key)) {
            metrics.messagesTotal.inc({ queue: QUEUE, severity, result: "duplicate_skipped" });
            log({ event: "duplicate_skipped", correlation_id: cid, hazard_id: event.hazard_id });
        } else {
            if (DELAY_MS) await sleep(DELAY_MS);
            metrics.messagesTotal.inc({ queue: QUEUE, severity, result: "alert_sent" });
            const publishedAt = Number(msg.properties.headers?.published_at_ms);
            if (publishedAt) metrics.alertLatency.observe({ severity }, Math.max(0, Date.now() - publishedAt) / 1000);
            log({
                event: "ALERT", correlation_id: cid, severity: event.severity,
                area: event.area_name, hazard_id: event.hazard_id, redelivered: msg.fields.redelivered,
            });
            sent.add(key);
        }
        ch.ack(msg);
    });
    metrics.brokerConnected.set(1);
    log({ event: "ready", queue: QUEUE, bindings: BINDINGS });
}

http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ status: "ok", service: QUEUE }));
    if (req.url === "/metrics") return metrics.handleMetrics(res);
    res.statusCode = 404; res.end("{}");
}).listen(process.env.PORT || 8102);

async function runWithRetry() {
    try {
        await start();
    } catch (e) {
        log({ event: "startup_failed", message: e.message });
        setTimeout(runWithRetry, 5000);
    }
}

runWithRetry();
