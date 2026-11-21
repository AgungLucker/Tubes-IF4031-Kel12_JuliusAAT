// Polling with leader election, so that every data source is fetched by exactly one instance
// at a time (see src/coordination/). Each source has its own lease, so with three instances
// the sources spread over them, and a dead leader is replaced within about one lease TTL.
//
// Each loop iteration: acquire-or-renew the lease -> if leader, read the cursor (AFTER taking
// the lease, so a handover resumes exactly where the previous leader's last committed poll
// ended: no gap) -> poll, with the epoch as fencing token on every write.
const { pollBmkg } = require("./pollBmkg");
const { pollPvmbg } = require("./pollPvmbg");
const { pollSatellite } = require("./pollSatellite");
const { getCursor, leases } = require("../store/ingestStatus");
const { shards } = require("../db/shards");
const { installFence } = require("../coordination/fence");
const { FencedError } = require("../coordination/errors");
const pollContext = require("../coordination/pollContext");
const { replayRetrying, replayParked } = require("./replayRejected");

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
const loops = [];

async function leaderLoop(name, job, { onNewTerm } = {}) {
    while (!stopping) {
        const startedAt = Date.now(); // local clock only paces the loop; it never decides leadership
        try {
            const lease = await leases.acquireOrRenew(name);
            if (lease && !stopping) {
                const ctx = { source: name, holder: leases.holder, epoch: lease.epoch };
                if (lease.newTerm) {
                    console.log(`[lease] ${name}: ${leases.holder} menjadi leader, epoch=${lease.epoch}`);
                    if (onNewTerm) await onNewTerm(ctx);
                }
                await pollContext.run(ctx, () => job(ctx));
            }
        } catch (error) {
            if (error instanceof FencedError) console.log(`[lease] ${name}: ${error.message}`);
            else console.log(`[lease] ${name}: siklus gagal - ${error.message}`);
        }
        if (!stopping) await sleep(Math.max(0, POLL_INTERVAL_MS - (Date.now() - startedAt)));
    }
}

// Lock a stale ex-leader out of every shard before the new leader's first poll.
async function fenceAllShards(ctx) {
    const { ok, failed } = await installFence(shards, ctx.source, ctx.epoch);
    if (failed.length) {
        console.log(`[fence] ${ctx.source} epoch=${ctx.epoch}: shard belum terjangkau ${failed.map((f) => f.shard).join(", ")} (difence saat tulis pertama)`);
    }
    return ok;
}

const sourceJob = (pollFn) => async (ctx) => pollFn(await getCursor(ctx.source), ctx);

async function init() {
    await leases.ensureSchema();
}

function startPoller() {
    init()
        .then(() => {
            loops.push(
                leaderLoop("BMKG", sourceJob(pollBmkg), { onNewTerm: fenceAllShards }),
                leaderLoop("PVMBG", sourceJob(pollPvmbg), { onNewTerm: fenceAllShards }),
                leaderLoop("SATELIT", sourceJob(pollSatellite), { onNewTerm: fenceAllShards }),
                // Retry/parked replay is a background job that must also run on one instance only.
                leaderLoop("REPLAY", () => replayRetrying(), {
                    onNewTerm: () => replayParked().catch((e) => console.log(`[replay] parked gagal: ${e.message}`)),
                })
            );
        })
        .catch((error) => console.log(`[lease] gagal menyiapkan skema koordinasi: ${error.message}`));
}

// Graceful stop: end the loops and hand the leases back so another instance takes over at once.
async function stopPoller() {
    stopping = true;
    const released = await leases.releaseAll().catch(() => []);
    if (released.length) console.log(`[lease] dilepas: ${released.join(", ")}`);
    await Promise.race([Promise.allSettled(loops), sleep(5000)]);
}

module.exports = { startPoller, stopPoller };
