async function getFeedHeadOffset() {
    try {
        const response = await fetch(`${process.env.SATELLITE_FEED_URL}/v1/session`, {
            headers: { Authorization: `Bearer ${process.env.SATELLITE_FEED_TOKEN}` },
            signal: AbortSignal.timeout(2000),
        });

        if (!response.ok) return null;
        const session = await response.json();

        return Number(session.latest_offset);

    } catch {
        return null
    }
}

module.exports = { getFeedHeadOffset };