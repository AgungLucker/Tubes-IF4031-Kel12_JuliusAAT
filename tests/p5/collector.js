// Kolektor AMQP untuk mengukur jalur alert kritis dari sisi PENERIMA, independen dari notifier.
// Dijalankan DI DALAM pod aggregator (amqplib dan RABBITMQ_URL sudah ada di sana):
//   kubectl exec -i <pod-aggregator> -- env SECS=180 KEYS="hazard.coastal.awas,hazard.*.awas" node - < collector.js
// Membuat antrean sementara (exclusive, auto-delete) yang ter-bind ke exchange hazard.events dengan routing key
// yang sama seperti notifier Tim Lapangan (hazard.*.awas), lalu mencetak satu baris JSON per pesan.
// Hanya pesan yang diterbitkan SELAMA kolektor hidup yang tertangkap, jadi mulai kolektor sebelum beban.
//
// Alasan terpisah dari notifier: notifier hanya mencatat latensi bila header published_at_ms ada, sedangkan
// jalur outbox (publishConfirmed) tidak mengisinya, jadi histogram latensi notifier kosong untuk alert kritis.
const amqp = require("amqplib");
const SECS = Number(process.env.SECS || 120);
const KEYS = (process.env.KEYS || "hazard.*.awas").split(",").map((s) => s.trim()).filter(Boolean);
const EXCHANGE = "hazard.events";

(async () => {
  const conn = await amqp.connect(process.env.RABBITMQ_URL);
  const ch = await conn.createChannel();
  await ch.assertExchange(EXCHANGE, "topic", { durable: true });
  const { queue } = await ch.assertQueue("", { exclusive: true, autoDelete: true });
  for (const k of KEYS) await ch.bindQueue(queue, EXCHANGE, k);
  console.error(JSON.stringify({ event: "kolektor_siap", queue, bindings: KEYS, secs: SECS }));
  await ch.consume(queue, (m) => {
    if (!m) return;
    const recv = Date.now();
    let ev = null;
    try { ev = JSON.parse(m.content.toString()); } catch { /* pesan bukan JSON */ }
    console.log(JSON.stringify({
      recv_ms: recv, key: m.fields.routingKey, redelivered: m.fields.redelivered,
      message_id: m.properties.messageId || null,
      hazard_id: ev?.hazard_id ?? null, source: ev?.source ?? null, source_ref_id: ev?.source_ref_id ?? null,
      severity: ev?.severity ?? null, occurred_at: ev?.occurred_at ?? null, ingested_at: ev?.ingested_at ?? null,
    }));
    ch.ack(m);
  });
  setTimeout(async () => { try { await conn.close(); } catch { /* sudah tertutup */ } process.exit(0); }, SECS * 1000);
})().catch((e) => { console.error(JSON.stringify({ error: String(e && e.message || e) })); process.exit(1); });
