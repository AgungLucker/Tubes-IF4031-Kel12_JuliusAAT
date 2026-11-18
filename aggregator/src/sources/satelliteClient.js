const { fetchJson } = require("./httpClient");

const BASE_URL = process.env.SATELLITE_PROCESSOR_URL || "http://satellite-processor:8083";
const API_KEY = process.env.SATELLITE_PROCESSOR_API_KEY;
const TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS || 2000);

function getFires(since) {
    const url = `${BASE_URL}/fires?since=${encodeURIComponent(since)}`
    return fetchJson(url, { headers: { "X-Satellite-Processor-Key": API_KEY }, timeoutMs: TIMEOUT_MS });
}

module.exports = { getFires }