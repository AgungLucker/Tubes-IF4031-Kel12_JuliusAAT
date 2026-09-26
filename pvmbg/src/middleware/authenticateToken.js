const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
    console.log("==========  DEBUG ==========");
    console.log("========================================");
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        console.log('Missing Authorization header');
        return res.status(401).json({
            error: 'Missing Authorization header'
        });
    }

    const [scheme, token] = authHeader.split(' ');

    console.log("========== AUTH HEADER DEBUG ==========");
    console.log("Auth Header :", authHeader);
    console.log("Scheme      :", scheme);
    console.log("Token       :", token);
    console.log("========================================");


    if (scheme !== 'Bearer' || !token) {
        console.log('Invalid Authorization header');
        return res.status(401).json({
            error: 'Invalid Authorization header'
        });
    }

    try {
        const payload = jwt.verify(
            token,
            process.env.PVMBG_SECRET_KEY
        );

        req.user = payload;

        next();
    } catch (error) {
        return res.status(401).json({
            error: 'Invalid or expired token'
        });
    }
}

module.exports = authenticateToken