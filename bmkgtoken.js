const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const jwtSecret = crypto.randomBytes(32).toString('hex');
const apiKeyBmkg = crypto.randomBytes(32).toString('hex');

const token = jwt.sign(
    {
        iss: 'pvmbg',
        sub: 'Aggregator',
        role: 'poller'
    },
    jwtSecret,
    {
        expiresIn: '48h'
    }
);

console.log('\n=== CREDENTIALS ===');
console.log('PVMBG_SECRET_KEY=' + jwtSecret);
console.log('BMKG_API_KEY=' + apiKeyBmkg);

console.log('\n=== JWT TOKEN ===');
console.log('PVMBG_TOKEN=' + token);