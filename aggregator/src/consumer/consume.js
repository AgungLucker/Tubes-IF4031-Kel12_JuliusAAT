const { pool } = require("../store/ingestStatus");
const amqp = require("amqplib");
const crypto = require("crypto");
const {fieldReportsTotal} = require("../metrics");

const EXCHANGE = "field-reports";
const QUEUE = "report-queue";

const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: QUEUE, ...o }));

async function startConsumer() {
    await ensureSchema();
    const conn = await amqp.connect(process.env.RABBITMQ_URL);
    conn.on("error", (err) => log({ event: "connection_error", message: err.message }));
    conn.on("close", () => {
        log({ event: "connection_closed", message: "Connection closed" });
        setTimeout(runWithRetry, 5000);
    })

    const ch = await conn.createChannel();
    await ch.assertExchange(EXCHANGE, "direct", { durable: true });
    await ch.assertQueue(QUEUE, { durable: true });
    await ch.bindQueue(QUEUE, EXCHANGE, "reports-queue");

    await ch.prefetch(10);

    await ch.consume(QUEUE, async (msg) => {
        if (!msg) return;

        const correlation_id = msg.properties.headers?.correlation_id;

        let event;
        try {
            event = JSON.parse(msg.content.toString("utf8"));
        } catch {
            event = { raw_base64: msg.content.toString("base64") };
        }

        const reportId = msg.properties.messageId
            || (typeof event?.report_id === "string" && event.report_id)
            || crypto.createHash("sha256").update(msg.content).digest("hex");

        try {
            const inserted = await storeFieldReports(reportId, event);
            log({ event: inserted ? "consumed" : "duplicate_skipped", correlation_id,
                  report_id: reportId, redelivered: msg.fields.redelivered });
            ch.ack(msg);
            fieldReportsTotal.inc({result:inserted ? "stored" : "duplicate"});

        } catch {
            fieldReportsTotal.inc({result: "failed"});
            setTimeout(() => {
                try { ch.nack(msg, false, true); } catch {  }
            }, 2000);
        }
    });

    log({event: 'ready'})
}


async function ensureSchema() {
    const query = `
        CREATE TABLE IF NOT EXISTS field_reports (
            report_id TEXT PRIMARY KEY,
            payload JSONB NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;

    try {
        await pool.query(query);
        console.log("[DB] Schema field_reports is ready");
    } catch (err) {
        console.error("[DB] Failed to ensure schema:", err.message);
        throw err;
    }
}



async function storeFieldReports(reportId, event) {
    try {
        const { rowCount } = await pool.query(
            `INSERT INTO field_reports (report_id, payload)
             VALUES ($1, $2)
             ON CONFLICT (report_id) DO NOTHING`,
            [reportId, JSON.stringify(event)]
        );
        return rowCount === 1;
    } catch (err) {
        log({ event: "store_failed", report_id: reportId, message: err.message });
        throw err;
    }
}



async function runWithRetry() {
    try {
        await startConsumer();
    } catch (e) {
        log({ event: "startup_failed", message: e.message });
        setTimeout(runWithRetry, 5000);
    }
}

module.exports = {
    runWithRetry
};




