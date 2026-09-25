const { fetchJson } = require("./httpClient");

const BASE_URL = process.env.BMKG_BASE_URL || "http://bmkg-mock:8081";
const API_KEY = process.env.BMKG_API_KEY;
const TIMEOUT_MS = Number(process.env.SOURCE_TIMEOUT_MS || 2000);

function getSeismicEvents(since) {
    const url = `${BASE_URL}/seismic-events?since=${encodeURIComponent(since)}`;
    return fetchJson(url, { headers: { "X-BMKG-Key": API_KEY }, timeoutMs: TIMEOUT_MS });
}

function getTsunamiWarnings(since) {
    const url = `${BASE_URL}/tsunami-warnings?since=${encodeURIComponent(since)}`;
    return fetchJson(url, { headers: { "X-BMKG-Key": API_KEY }, timeoutMs: TIMEOUT_MS });
}

module.exports = { getSeismicEvents, getTsunamiWarnings };