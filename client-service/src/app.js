import express from 'express';
import { randomUUID } from 'node:crypto';
// import { createAuth } from './auth.js';
import { resolveFields, project } from './allowList.js';
import { HttpError } from './error.js';
import { callJson } from './http.js';
import { log } from './logger.js';
// import rateLimit from 'express-rate-limit';
import { verifyJwt, checkSession } from './auth.js';
import { publishFieldReports } from './publisher.js';
import { httpMetrics, metricsHandler, fieldReportsTotal, fieldReportPublishDuration, shedTotal } from './metric.js';
import { createShedder, prioritize } from './shed.js';

const HAZARD_TYPES = new Set(['SEISMIC', 'TSUNAMI', 'VOLCANIC', 'WILDFIRE', 'COASTAL']);
const SOURCES = new Set(['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI']);


export function createApp({ cfg, keys }) {
    const app = express();
    const shedder = createShedder({
      maxInflight: cfg.maxInflight, mediaShare: cfg.mediaShare, onShed: (priority) => shedTotal.inc({ priority }),
    });
    app.disable('x-powered-by');
    app.use(express.json());
    app.use(httpMetrics);
    app.get('/metrics', metricsHandler);
    app.use((req, res, next) => {
        req.cid = req.get('X-Correlation-ID') || randomUUID();
        res.set('X-Correlation-ID', req.cid);
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            log.info({
                event: 'request', correlation_id: req.cid, method: req.method, path: req.path,
                status: res.statusCode, client_id: req.auth?.clientId,
                latency_ms: Number(process.hrtime.bigint() - start) / 1e6,
            });
        });
        next();
    });

    app.get('/health', (req, res) => res.json({ status: 'ok', service: 'client-service' }));
    app.get('/health/load', (req, res) => res.json(shedder.stats()));

    app.get('/data', verifyJwt(cfg), prioritize(cfg), shedder.admit, checkSession(cfg), async (req, res) => {
        const fields = resolveFields(req.auth.scope, req.query.fields);
        const { hazard_type, source, limit, cursor } = req.query;

        if (hazard_type !== undefined && !HAZARD_TYPES.has(hazard_type)) {
            throw new HttpError(400, 'invalid_request', `hazard_type must be one of: ${[...HAZARD_TYPES].join(', ')}`);
        }
        if (source !== undefined && !SOURCES.has(source)) {
            throw new HttpError(400, 'invalid_request', `source must be one of: ${[...SOURCES].join(', ')}`);
        }
        if (limit !== undefined && !/^[1-9]\d{0,3}$/.test(limit)) {
            throw new HttpError(400, 'invalid_request', 'limit must be a positive integer');
        }

        const params = new URLSearchParams();
        if (hazard_type) params.set('hazard_type', hazard_type);
        if (source) params.set('source', source);
        // Pagination lintas shard (P1 #2): limit dan cursor buram diteruskan apa adanya.
        if (limit) params.set('limit', limit);
        if (cursor) params.set('cursor', cursor);
        const qs = params.size ? `?${params}` : '';
        let r;

        try {
            r = await callJson('aggregator', `${cfg.aggregatorUrl}/hazard-events${qs}`, {
                cid: req.cid, timeoutMs: cfg.aggregatorTimeoutMs,
                headers: { 'X-Client-Priority': req.priority },
            });

        } catch {
            throw new HttpError(503, 'upstream_unavailable', 'Aggregator unavailable');
        }

        if (r.status === 429) throw new HttpError(429, 'rate_limited', 'Too many requests');
        if (r.status === 400) throw new HttpError(400, 'invalid_request', r.data?.error?.message ?? 'Invalid request');


        const body = {
            data: r.data.data.map((row) => project(row, fields)),
            next_cursor: r.data.next_cursor ?? null,
            partial: Boolean(r.data.partial),
            unavailable_units: r.data.unavailable_units ?? [],
        };
        if (r.data.stale_since) body.stale_since = r.data.stale_since;
        if (r.data.source_status) body.source_status = r.data.source_status;
        res.set('Cache-Control', 'no-store').json(body);
    });

    app.get('/rejected-messages', verifyJwt(cfg), checkSession(cfg), async (req, res) => {
        if (req.auth.clientId !== cfg.internalClientId) {
            throw new HttpError(403, 'forbidden', 'Only internal client allowed to read rejected messages');
        }

        const { source, limit, cursor } = req.query;
        if (source !== undefined && !SOURCES.has(source)) {
            throw new HttpError(400, 'invalid_request', `source must be one of: ${[...SOURCES].join(', ')}`);
        }

        const params = new URLSearchParams();
        if (source) params.set('source', source);
        if (limit) params.set('limit', limit);
        if (cursor) params.set('cursor', cursor);
        const qs = params.size ? `?${params}` : '';
        let r;

        try {
            r = await callJson('aggregator', `${cfg.aggregatorUrl}/rejected-messages${qs}`, {
                cid: req.cid, timeoutMs: cfg.upstreamTimeoutMs,
            });
        } catch {
            throw new HttpError(503, 'upstream_unavailable', 'Aggregator unavailable');
        }

        if (r.status === 429) throw new HttpError(429, 'rate_limited', 'Too many requests');
        if (r.status === 400) throw new HttpError(400, 'invalid_request', r.data?.error?.message ?? 'Invalid request');
        if (r.status !== 200) throw new HttpError(503, 'upstream_unavailable', 'Aggregator unavailable');

        res.set('Cache-Control', 'no-store').json({ items: r.data.items, next_cursor: r.data.next_cursor });
    })

    app.post('/field-reports', verifyJwt(cfg), checkSession(cfg), async (req, res) => {
        if (req.auth.clientId === "lapangan-client") {
            const reportId = req.get('Idempotency-Key') ?? req.body?.report_id ?? randomUUID();
            const end = fieldReportPublishDuration.startTimer();
            try {
                await publishFieldReports(req.body, String(reportId));
                end({ result: 'accepted' });
                fieldReportsTotal.inc({ result: 'accepted' });

                return res.status(202).json({
                    message: "Report accepted",
                    report_id: String(reportId)
                });

            } catch (err) {
                end({ result: 'broker_unavailable' });
                fieldReportsTotal.inc({ result: 'broker_unavailable' });
                return res.status(503).json({
                    message: "Failed to publish report"
                });
            }
        }
        fieldReportsTotal.inc({ result: 'forbidden' });
        return res.status(403).json({
            message: "Only lapangan-client allowed to post field report"
        });

    });


    app.use((req, res) => res.status(404).json({ error: 'not_found' }));

    app.use((err, req, res, next) => {
        if (err instanceof HttpError)
            return res.status(err.status).json({ error: err.code, error_description: err.message });
        log.error({ event: 'unhandled', correlation_id: req.cid, message: err.message });
        res.status(500).json({ error: 'server_error' });
    });

    return app;

}