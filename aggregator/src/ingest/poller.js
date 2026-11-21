// Polling with leader election, so that every data source is fetched by exactly one instance
// at a time (see src/coordination/). Each source has its own lease, so with three instances
// the sources spread over them, and a dead leader is replaced within about one lease TTL.
const { pollBmkg } = require("./pollBmkg");
const { pollPvmbg } = require("./pollPvmbg");
const { pollSatellite } = require("./pollSatellite");
const { getCursor, leases } = require("../store/ingestStatus");
const { shards } = require("../db/shards");
const { installFence } = require("../coordination/fence");
const { FencedError } = require("../coordination/errors");
const pollContext = require("../coordination/pollContext");
const { replayRetrying, replayParked } = require("./replayRejected");
const { isLeader, leaseEpoch, pollDuration, pollTotal, lastSuccessfulPollTimestamp, fencedWritesTotal } = require("../metrics");

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 3000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopping = false;
const loops = [];

async function leaderLoop(name, job, { onNewTerm } = {}) {
    while (!stopping) {
        const startedAt = Date.now();
        let end = null; 
        try {
            const lease = await leases.acquireOrRenew(name);
            if (lease && !stopping) {
                const ctx = { source: name, holder: leases.holder, epoch: lease.epoch };
                isLeader.set({source: name}, 1);
                if (lease.newTerm) {
                    leaseEpoch.set({source:name},lease.epoch);
                    console.log(`[lease] ${name}: ${leases.holder} menjadi leader, epoch=${lease.epoch}`);
                    if (onNewTerm) await onNewTerm(ctx);
                }
                end = pollDuration.startTimer({source:name});
                const result = (await pollContext.run(ctx, () => job(ctx))) ?? "success";
                if (result === "fenced") {
                    fencedWritesTotal.inc({source:name});
                    isLeader.set({source:name}, 0);
                }
                pollTotal.inc({source:name, result});
                if (result === "success") lastSuccessfulPollTimestamp.set({source:name}, Date.now()/1000);
            } else{
                isLeader.set({source:name},0)
            }
        } catch (error) {
            isLeader.set({source:name}, 0); 
            if (error instanceof FencedError){
                fencedWritesTotal.inc({source:name});
                pollTotal.inc({source:name,result:"fenced"});
                console.log(`[lease] ${name}: ${error.message}`);
            } else {
                pollTotal.inc({source:name,result:"error"});
                console.log(`[lease] ${name}: siklus gagal - ${error.message}`);
            }
        } finally {
            end?.();
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
