
const shards = require("../shards");
const { BUCKETS, makeHazardId, bucketOf } = require("../hazardId");

function shardIndexForBucket(bucket) {
    return Math.floor((bucket * shards.length) / BUCKETS);
}

function shardFor(hazardId) {
    return shards[shardIndexForBucket(bucketOf(hazardId))];
}

function shardByName(name) {
    return shards.find((s) => s.name === name);
}

function bucketRanges() {
    return shards.map((s, idx) => {
        const owned = [];
        for (let b = 0; b < BUCKETS; b++) if (shardIndexForBucket(b) === idx) owned.push(b);
        return { shard: s.name, buckets: owned.length ? [owned[0], owned[owned.length - 1]] : [] };
    });
}

module.exports = {
    BUCKETS,
    makeHazardId,
    bucketOf,
    shardIndexForBucket,
    shardFor,
    shardByName,
    bucketRanges,
    shards,
};
