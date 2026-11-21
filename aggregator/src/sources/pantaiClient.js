const { fetchJson } = require("./httpClient");

const BASE_URL = process.env.PANTAI_BASE_URL || "http://sensor-pantai:8080";
const TOKEN = process.env.PANTAI_AUTH_TOKEN;
const TIMEOUT_MS = Number(process.env.PANTAI_TIMEOUT_MS || 1500);
const PAGE_LIMIT = Number(process.env.PANTAI_PAGE_LIMIT || 200);

const headers = () => ({ Authorization: `Bearer ${TOKEN}` });

function getStations() {
    return fetchJson(`${BASE_URL}/v1/stations`, { headers: headers(), timeoutMs: TIMEOUT_MS });
}

function getObservations(cursor) {
    const q = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) q.set("cursor", cursor);
    return fetchJson(`${BASE_URL}/v1/observations?${q}`, { headers: headers(), timeoutMs: TIMEOUT_MS });
}

module.exports = { getStations, getObservations };
