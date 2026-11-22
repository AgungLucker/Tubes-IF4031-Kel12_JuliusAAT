const { fetchJson } = require("./httpClient");

const BASE_URL = process.env.SATELLITE_PROCESSOR_URL || "http://satellite-processor:8083";
const API_KEY = process.env.SATELLITE_PROCESSOR_API_KEY;
const TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS || 2000);
const PAGE_LIMIT = Number(process.env.SATELLITE_PAGE_LIMIT || 30);


function getFires(since, afterId = "") {
    const params = new URLSearchParams({ since, after_id: afterId, limit: PAGE_LIMIT });
    return fetchJson(`${BASE_URL}/fires?${params}`, { headers: { "X-Satellite-Processor-Key": API_KEY }, timeoutMs: TIMEOUT_MS });
}

module.exports = { getFires }