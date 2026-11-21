import client from '@prometheus-io/client';

export const register = new client.Registry();
register.setDefaultLabels({ service: 'bnpb-token-service', pod: process.env.HOSTNAME || 'local' });
client.collectDefaultMetrics({ register });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const httpRequests = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [register],
});

const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    buckets: LATENCY_BUCKETS,
    registers: [register],
});

export const authOperations = new client.Counter({
    name: 'bnpb_token_auth_operations_total',
    help: 'Auth operations per operation and result',
    labelNames: ['op', 'result'],
    registers: [register],
});


export const loginsByClient = new client.Counter({
    name: 'bnpb_token_logins_total',
    help: 'Successful logins per client',
    labelNames: ['client'],
    registers: [register],
});

for (const [op, results] of Object.entries({
    login: ['success', 'invalid_client', 'invalid_secret'],
    refresh: ['success', 'invalid_grant'],
    introspect: ['active', 'inactive', 'unauthorized'],
})) for (const result of results) authOperations.inc({ op, result }, 0);

export function httpMetrics(req, res, next) {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
        const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
        httpRequests.inc({ method: req.method, route, status: res.statusCode });
        end({ method: req.method, route });
    });
    next();
}

export async function metricsHandler(_req, res) {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
}
