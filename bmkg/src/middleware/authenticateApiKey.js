const API_KEY = process.env.BMKG_API_KEY;

function authenticateApiKey(req, res, next) {

    const key = req.headers['x-bmkg-key'];
    if (!key) {
        console.log("Missing header");
        return res.status(401).json({
            error: 'Missing X-BMKG-Key header'
        });
    }

    if (key !== API_KEY) {
        console.log("Invalid API Key");
        return res.status(402).json({
            error: 'Invalid API key'
        });
    }

    next();
}

module.exports = authenticateApiKey;