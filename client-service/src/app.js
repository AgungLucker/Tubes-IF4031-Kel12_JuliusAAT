import express from 'express';
import { randomUUID } from 'node:crypto';
import { createAuth } from './auth.js';
import { resolveFields, project } from './allowList.js';
import { HttpError } from './error.js';
import { callJson } from './http.js';
import { log } from './logger.js';

const HAZARD_TYPES = new Set(['SEISMIC', 'VOLCANIC']);


export function createApp({cfg, keys}) {
    const app = express();
    app.disable('x-powered-by');

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

    app.get('/data', createAuth(cfg), async (req, res) => {
        const fields = resolveFields(req.auth.scope, req.query.fields);
        const {hazard_type} = req.query;
        
        if (hazard_type !== undefined && !HAZARD_TYPES.has(hazard_type)) throw new HttpError(400, 'invalid_request', 'hazard_type must be SEISMIC or VOLCANIC');


        const qs = hazard_type ? `?hazard_type=${hazard_type}` : '';
        let r;

        try{
            r = await callJson('aggregator', `${cfg.aggregatorUrl}/hazard-events${qs}`, {
                cid: req.cid, timeoutMs: cfg.upstreamTimeoutMs,});

        } catch{
                  throw new HttpError(503, 'upstream_unavailable', 'Aggregator unavailable');
        }

        if (r.status === 429) throw new HttpError(429, 'rate_limited', 'Too many requests');

        const body = { data: r.data.data.map((row) => project(row, fields)) };
        if (r.data.stale_since) body.stale_since = r.data.stale_since;
        res.set('Cache-Control', 'no-store').json(body);
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