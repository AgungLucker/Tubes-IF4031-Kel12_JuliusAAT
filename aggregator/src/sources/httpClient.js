async function fetchJson(url, { headers = {}, timeoutMs = 2000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    let status = "ERROR";

    try {
        const response = await fetch(url, { headers, signal: controller.signal });
        status = response.status;

        if (!response.ok) {
            throw new Error(`Request to ${url} failed with status ${response.status}`);
        }

        return await response.json();
    } finally {
        const durationMs = Date.now() - startedAt;
        console.log(`[outbound] GET ${url} -> ${status} (${durationMs}ms)`);
        clearTimeout(timer);
    }
}

module.exports = { fetchJson };
