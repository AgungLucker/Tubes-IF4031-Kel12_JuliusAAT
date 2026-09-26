const minDelay = 50
const maxDelay = 150

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function bmkgDelay(req, res, next) {
    const delay =
        minDelay + Math.random() * (maxDelay - minDelay);

    await sleep(delay);

    next();
}

module.exports = bmkgDelay;