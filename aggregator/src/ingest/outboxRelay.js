const outbox = require("../store/criticalOutbox");
const { publishConfirmed } = require("../broker/publisher");
const metrics = require("../metrics");

const BATCH = Number(process.env.OUTBOX_BATCH || 50);
const MAX_BATCHES_PER_CYCLE = 10;

async function relayOnce() {
    for (let i = 0; i < MAX_BATCHES_PER_CYCLE; i++) {
        const rows = await outbox.claimPending(BATCH);
        if (rows.length === 0) break;
        for (const row of rows) {
            try {
                await publishConfirmed(row.payload, { routingKey: row.routing_key, messageId: row.hazard_id });
                await outbox.markSent(row.hazard_id);
                metrics.inc("critical_alerts_published_total");
                // from our receipt of the observation to the broker's confirm
                metrics.observe("critical_alert_publish_seconds", Number(row.age_s));
            } catch (err) {
                metrics.inc("critical_alert_publish_failures_total");
                await outbox.markFailed(row.hazard_id, err.message).catch(() => {});
                console.log(`[outbox] ${row.hazard_id}: publish gagal (${err.message}), akan dicoba lagi`);
                return refreshGauges(); // broker unavailable: do not hammer it within this cycle
            }
        }
    }
    await refreshGauges();
}

async function refreshGauges() {
    const { pending, oldest_s } = await outbox.pendingStats();
    metrics.setGauge("critical_outbox_pending", pending);
    metrics.setGauge("critical_outbox_oldest_seconds", Number(oldest_s));
}

module.exports = { relayOnce };
