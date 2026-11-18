const fs = require("fs");
const https = require("https");

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const CACHE_MS = Number(process.env.POD_LOCATOR_CACHE_MS || 3000);
const TIMEOUT_MS = 2000;

let cache = { at: 0, value: null };

function inCluster() {
    return Boolean(process.env.KUBERNETES_SERVICE_HOST) && fs.existsSync(`${SA_DIR}/token`);
}

function apiGet(path) {
    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                host: process.env.KUBERNETES_SERVICE_HOST,
                port: process.env.KUBERNETES_SERVICE_PORT || 443,
                path,
                method: "GET",
                ca: fs.readFileSync(`${SA_DIR}/ca.crt`),
                headers: { Authorization: `Bearer ${fs.readFileSync(`${SA_DIR}/token`, "utf8").trim()}` },
                timeout: TIMEOUT_MS,
            },
            (res) => {
                let body = "";
                res.on("data", (d) => (body += d));
                res.on("end", () => {
                    if (res.statusCode !== 200) return reject(new Error(`k8s API ${res.statusCode}: ${body.slice(0, 200)}`));
                    try {
                        resolve(JSON.parse(body));
                    } catch (e) {
                        reject(e);
                    }
                });
            }
        );
        req.on("timeout", () => req.destroy(new Error("k8s API timeout")));
        req.on("error", reject);
        req.end();
    });
}

function isReady(pod) {
    return (pod.status?.conditions || []).some((c) => c.type === "Ready" && c.status === "True");
}

async function listShardInstances() {
    if (!inCluster()) return { available: false, byShard: {} };
    if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;

    const ns = fs.readFileSync(`${SA_DIR}/namespace`, "utf8").trim();
    const selector = encodeURIComponent("cnpg.io/cluster,cnpg.io/podRole=instance");
    try {
        const list = await apiGet(`/api/v1/namespaces/${ns}/pods?labelSelector=${selector}`);
        const byShard = {};
        for (const pod of list.items || []) {
            const labels = pod.metadata.labels || {};
            const shard = labels["cnpg.io/cluster"];
            (byShard[shard] ??= []).push({
                pod: pod.metadata.name,
                node: pod.spec.nodeName || null,
                role: labels["cnpg.io/instanceRole"] === "primary" ? "primary" : "replica",
                ready: isReady(pod) && !pod.metadata.deletionTimestamp,
            });
        }
        for (const list of Object.values(byShard)) list.sort((a, b) => a.pod.localeCompare(b.pod));
        cache = { at: Date.now(), value: { available: true, byShard } };
        return cache.value;
    } catch (err) {
        console.error(`[k8s] gagal membaca pod shard: ${err.message}`);
        return { available: false, byShard: {} };
    }
}

async function locateShard(shardName) {
    const { available, byShard } = await listShardInstances();
    const instances = (byShard[shardName] || []).filter((i) => i.ready && i.node);
    let r = 0;
    const locations = instances
        .sort((a, b) => (a.role === b.role ? a.pod.localeCompare(b.pod) : a.role === "primary" ? -1 : 1))
        .map((i) => ({
            node: i.node,
            unit: i.role === "primary" ? shardName : `${shardName}-r${++r}`,
            role: i.role,
        }));
    return { available, locations, instances: byShard[shardName] || [] };
}

module.exports = { listShardInstances, locateShard, inCluster };
