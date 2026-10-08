const amqp = require("amqplib");
const http = require("http");

const EXCHANGE = "hazard.events";
const QUEUE = "dashboard-updater";
const state = new Map();

const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: QUEUE, ...o }));

async function startConsumer() {
    const conn = await amqp.connect(process.env.RABBITMQ_URL);
    conn.on("close", () => {
        log({ event: "connection_closed", message: "Connection closed" });
        setTimeout(startConsumer, 5000);
    })

    const ch = await conn.createChannel();
    await ch.assertExchange(EXCHANGE, "topic", { durable: true });
    await ch.assertQueue(QUEUE, { durable: true });
    await ch.bindQueue(QUEUE, EXCHANGE, "hazard.*.*");

    await ch.consume(QUEUE, (msg) => {
        if (!msg) return;

        const event = JSON.parse(msg.content.toString());

        state.set(event.hazard_id, event);

        log({event: "consumed", correlation_id: msg.properties.headers?.correlation_id,
            hazard_id: event.hazard_id, severity: event.severity, redelivered: msg.fields.redelivered});

        ch.ack(msg);
    })

    log({event: 'ready'})
}

http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") return res.end(JSON.stringify({ status: "ok", service: QUEUE }));
    if (req.url === "/state") return res.end(JSON.stringify({ count: state.size, events: [...state.values()] }));
    res.statusCode = 404; res.end("{}");
}).listen(process.env.PORT || 8101);


startConsumer().catch((e) => { log({ event: "startup_failed", message: e.message }); process.exit(1); });


