import client from '@prometheus-io/client';
import { isPublisherReady } from './publisher.js';

export const register = new client.Registry();
register.setDefaultLabels({ service: 'client-service', pod: process.env.HOSTNAME || 'local' });
client.collectDefaultMetrics({ register });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];


const httpRequests = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status', 'client'],
    registers: [register],
});

const httpDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'client'],
    buckets: LATENCY_BUCKETS,
    registers: [register],
});


export const upstreamRequests = new client.Counter({
    name: 'client_service_upstream_requests_total',
    help: 'Outbound calls per target and status (status=error for timeout/network failure)',
    labelNames: ['target', 'status'],
    registers: [register],
});

export const upstreamDuration = new client.Histogram({
    name: 'client_service_upstream_request_duration_seconds',
    help: 'Outbound call duration per target',
    labelNames: ['target'],
    buckets: LATENCY_BUCKETS,
    registers: [register],
});

export const shedTotal = new client.Counter({
    name: 'client_service_shed_total',
    help: 'Requests refused by load shedding (429), per priority class (high = Tim Lapangan/internal, low = Media)',
    labelNames: ['priority'],
    registers: [register],
});
shedTotal.inc({ priority: 'high' }, 0);
shedTotal.inc({ priority: 'low' }, 0);

export const fieldReportsTotal = new client.Counter({
    name: 'client_service_field_reports_total',
    help: 'POST /field-reports outcomes (accepted|broker_unavailable|forbidden)',
    labelNames: ['result'],
    registers: [register],
});

export const fieldReportPublishDuration = new client.Histogram({
    name: 'client_service_field_report_publish_duration_seconds',
    help: 'Time from publish until broker confirm (or failure)',
    labelNames: ['result'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5],
    registers: [register],
});

new client.Gauge({
    name: 'client_service_broker_connected',
    help: '1 if the RabbitMQ publisher channel is open, else 0',
    registers: [register],
    collect() { this.set(isPublisherReady() ? 1 : 0); },
});


for (const result of ['accepted', 'broker_unavailable', 'forbidden']) fieldReportsTotal.inc({ result }, 0);

export function httpMetrics(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
        const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
        const clientId = req.auth?.clientId ?? 'anonymous';
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        httpRequests.inc({ method: req.method, route, status: res.statusCode, client: clientId });
        httpDuration.observe({ method: req.method, route, client: clientId }, seconds);
    });
    next();
}

export async function metricsHandler(req, res) {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
}
