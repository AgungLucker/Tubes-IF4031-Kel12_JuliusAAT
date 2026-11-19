const IDLE_MS = 30000; // asumsi, sesuaikan dengan interval heartbeat asli
const MIN_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const YIELD_EVERY = 50;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));


function parseSSEBlock(block) {
    const event = { id: null, type: "message", data: "" };
    for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue; // baris komentar
        const idx = line.indexOf(":");
        const field = idx === -1 ? line : line.slice(0, idx);
        const value = idx === -1 ? "" : line.slice(idx + 1).replace(/^ /, "");
        if (field === "id") event.id = value;
        else if (field === "event") event.type = value;
        else if (field === "data") event.data += (event.data ? "\n" : "") + value;
    }
    return event;
}


async function readStream({ url, token, from, onEvent }) {
    const controller = new AbortController();
    let idle;
    const arm = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), IDLE_MS);
    };

    try {
        arm();
        const res = await fetch(`${url}/v1/stream?from=${from}`, {
            headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
            signal: controller.signal,
        });
        if (!res.ok) {
            const err = new Error(`feed responded ${res.status}`);
            err.status = res.status;
            throw err;
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let processed = 0;
        for await (const chunk of res.body) {
            arm();
            buffer += decoder.decode(chunk, { stream: true });
            buffer = buffer.replace(/\r\n/g, "\n");
            let sep;
            while ((sep = buffer.indexOf("\n\n")) !== -1) {
                const block = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);

                if (block.trim()) {
                    await onEvent(parseSSEBlock(block));
                    if (++processed % YIELD_EVERY === 0) await yieldToEventLoop();
                }
            }
        }
    } finally {
        clearTimeout(idle);
    }
}

async function startFeedConsumer({ getLastOffset, onEvent }) {
    const url = process.env.SATELLITE_FEED_URL;
    const token = process.env.SATELLITE_FEED_TOKEN;
    let delay = MIN_DELAY_MS;

    while (true) {
        try {
            const from = await getLastOffset();
            console.log(`[feed] menyambung dari offset ${from}`);
            await readStream({
                url, token, from,
                onEvent: async (event) => {
                    delay = MIN_DELAY_MS; // data masuk berarti koneksi sehat
                    await onEvent(event);
                },
            });
            console.log("[feed] aliran ditutup server");
        } catch (err) {
            console.log(`[feed] gagal: ${err.message}`);
        }
        await sleep(delay);
        delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
}

module.exports = { startFeedConsumer };

