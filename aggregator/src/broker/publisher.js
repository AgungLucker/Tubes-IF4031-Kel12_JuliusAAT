const amqp = require('amqplib');
const {randomUUID} = require('crypto');

const EXCHANGE_NAME = "hazard.events";
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
        await ch.assertExchange(EXCHANGE_NAME, 'topic', {durable: true});
        channel = ch;
        console.log("Publisher connected to RabbitMQ");
    } catch (err) {
        console.error("Failed to connect to RabbitMQ:", err);
        retryConnect();
    }
}

async function publishHazardEvent(event) {
    if (!channel) {
        console.error("Channel is not initialized. Cannot publish event.");
        return;
    }

    const key = `hazard.${event.hazard_type.toLowerCase()}.${event.severity.toLowerCase()}`;
    channel.publish(
        EXCHANGE_NAME,
        key,
        Buffer.from(JSON.stringify(event)),
        {
            persistent: true,
            messageId: randomUUID(),
            contentType: 'application/json',
            headers: {
                correlation_id: randomUUID()
            }
        },
        (err) => {
            if (err) {
                console.error("Failed to publish event:", err);
            } else {
                console.log(`Event published with key: ${key}`);
            }   
        }
    )
}

module.exports = {
    startPublisher,
    publishHazardEvent
};