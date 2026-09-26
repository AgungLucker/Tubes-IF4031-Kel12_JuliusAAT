const minDelay = Number(process.env.PVMBG_MIN_DELAY || 500);
const maxDelay = Number(process.env.PVMBG_MAX_DELAY || 3000);

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pvmbgDelay(req, res, next) {
    const delay =
        minDelay + Math.random() * (maxDelay - minDelay);

    await sleep(delay);

    next();
}

module.exports = pvmbgDelay;