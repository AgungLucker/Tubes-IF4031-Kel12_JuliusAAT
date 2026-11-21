const { upstreamHeaders } = require("../coordination/pollContext");

const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 1048576);
const MAX_JSON_DEPTH = Number(process.env.MAX_JSON_DEPTH || 64);

class BadPayloadError extends Error {
    constructor(reason, raw) {
        super(reason);
        this.reason = reason;
        this.raw = raw;
    }
}

async function readBody(response) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
        chunks.push(chunk);
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            const raw = Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES);
            throw new BadPayloadError(`payload_too_large: lebih dari ${MAX_BODY_BYTES} byte`, raw);
        }
    }
    return Buffer.concat(chunks);
}

function exceedsDepth(text) {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (ch === "\\") i++;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === "[" || ch === "{") {
            if (++depth > MAX_JSON_DEPTH) return true;
        } else if (ch === "]" || ch === "}") {
            depth--;
        }
    }
    return false;
}

function parseJson(raw) {
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
        throw new BadPayloadError("invalid_encoding: bukan UTF-8 yang valid", raw);
    }

    if (exceedsDepth(text)) {
        throw new BadPayloadError(`payload_too_deep: kedalaman melebihi ${MAX_JSON_DEPTH}`, raw);
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new BadPayloadError(`invalid_json: ${error.message}`, raw);
    }
}

async function fetchJson(url, { headers = {}, timeoutMs = 2000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let status = "ERROR";

    try {
        const response = await fetch(url, {
            headers: { ...headers, ...upstreamHeaders() },
            signal: controller.signal,
        });
        status = response.status;

        if (!response.ok) {
            throw new Error(`Request to ${url} failed with status ${response.status}`);
        }

        return parseJson(await readBody(response));
    } finally {
        const durationMs = Date.now() - startedAt;
        console.log(`[outbound] GET ${url} -> ${status} (${durationMs}ms)`);
        clearTimeout(timer);
    }
}

module.exports = { fetchJson, parseJson, BadPayloadError };
