const amqp = require('amqplib');
const {randomUUID} = require('crypto');

const EXCHANGE_NAME = "field-reports";
let channel = null;
let retrying=false;

function retryConnect() {
    if (retrying) return;
    retrying = true;
    console.log("Retrying connection to RabbitMQ in 5 seconds...");
    channel = null;
    setTimeout(() => {retrying = false; startPublisher();}, 5000);
}

async function startPublisher() {
    try {
        const conn = await amqp.connect(process.env.RABBITMQ_URL);
        conn.on('error', (err) => {
            console.error("Connection error:", err);
        });
        conn.on("close", () => {
            console.error("Connection closed, retrying...");
            retryConnect();
        });

        const ch =  await conn.createConfirmChannel();
        ch.on('error', (err) => console.error("Channel error:", err.message));
        ch.on('close', () => { if (channel === ch) channel = null; });
        await ch.assertExchange(EXCHANGE_NAME, 'direct', {durable: true});
        await ch.assertQueue("report-queue",{ durable: true });
        await ch.bindQueue("report-queue",EXCHANGE_NAME,"reports-queue");
        channel = ch;
        console.log("Publisher connected to RabbitMQ");
    } catch (err) {
        console.error("Failed to connect to RabbitMQ:", err);
        retryConnect();
    }
}

function publishFieldReports(event, reportId, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
        if (!channel) {
            return reject(
                new Error("RabbitMQ channel unavailable")
            );
        }

        const timer = setTimeout(() => reject(new Error("Broker confirm timeout")), timeoutMs);

        try {
            channel.publish(
                EXCHANGE_NAME,
                "reports-queue",
                Buffer.from(JSON.stringify(event ?? null)),
                {
                    persistent: true,
                    messageId: reportId,
                    contentType: "application/json"
                },
                (err) => {
                    clearTimeout(timer);
                    if (err) return reject(err);
                    resolve();
                }
            );
        } catch (err) {
            clearTimeout(timer);
            reject(err);
        }
    });
}

function isPublisherReady() {
    return channel !== null;
}

module.exports = {
    startPublisher,
    publishFieldReports,
    isPublisherReady
};