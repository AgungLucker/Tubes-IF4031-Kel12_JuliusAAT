const jwt = require('jsonwebtoken');

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];

    if (!authHeader) {
        console.log('Missing Authorization header');
        return res.status(401).json({
            error: 'Missing Authorization header'
        });
    }

    const [scheme, token] = authHeader.split(' ');
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