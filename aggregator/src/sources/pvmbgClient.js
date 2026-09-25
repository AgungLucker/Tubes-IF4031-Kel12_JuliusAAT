const { fetchJson } = require("./httpClient");

const BASE_URL = process.env.PVMBG_BASE_URL || "http://pvmbg-mock:8082";
const TOKEN = process.env.PVMBG_TOKEN;
const TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS || 2000);

function getVolcanicReports(since) {
    const url = `${BASE_URL}/volcanic-reports?since=${encodeURIComponent(since)}`;
    return fetchJson(url, { headers: { Authorization: `Bearer ${TOKEN}` }, timeoutMs: TIMEOUT_MS });
}

module.exports = { getVolcanicReports };
