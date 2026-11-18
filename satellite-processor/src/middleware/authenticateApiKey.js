const API_KEY = process.env.SATELLITE_PROCESSOR_API_KEY;

function authenticateApiKey(req, res, next) {
    const key = req.headers["x-satellite-processor-key"];
    if (!key) {
        return res.status(401).json({
            error: "Missing X-Satellite-Processor-Key header"
        });
    }
    if (key !== API_KEY) {
        return res.status(401).json({
            error: "Invalid API key"
        });
    }
    next();
}

module.exports = authenticateApiKey;
