const { getOutageStatus } = require('../routes/adminOutage');

function isCurrentlyOutage(req, res, next) {
    if (getOutageStatus()) {
        return res.status(503).json({
            error: 'PVMBG service unavailable (outage)'
        });
    }

    next();
}

module.exports = isCurrentlyOutage;