import express from 'express';
import { randomUUID } from 'node:crypto';
import { AuthError } from './tokenService.js';
import {log} from './logger.js'

const isStr = (v) => typeof v === 'string' && v.length > 0;
export function createApp({cfg, keys, tokens}){
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json());
    const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
    app.use

    app.use((req, res, next) => {
        req.cid = req.get('X-Correlation-ID') || randomUUID();
        res.set('X-Correlation-ID', req.cid);
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            log.info({
                event: 'request', correlation_id: req.cid, method: req.method, path: req.path,
                status: res.statusCode, latency_ms: Number(process.hrtime.bigint() - start) / 1e6,
            });
        });
        next();
    });

    app.get('/health', (req, res) => res.json({status: 'ok', service: 'bnpb-token-service'}));

    app.post('/auth/token', wrap(async (req, res) => {
        const {client_id, client_secret} = req.body || {};

        const result = await tokens.login(client_id, client_secret);
        log.info({ event: 'login', correlation_id: req.cid, client_id });
        res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json(result);
    }));

    app.post('/auth/refresh', wrap(async (req, res) => {
        const { refresh_token } = req.body || {};
        if (!isStr(refresh_token))
        throw new AuthError(400, 'invalid_request', 'refresh_token is required');
        const result = await tokens.refresh(refresh_token);
        log.info({ event: 'refresh', correlation_id: req.cid });
        res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }).json(result);
    }));

    app.post('/auth/introspect', wrap(async (req, res) => {
        if ((req.get('X-Service-Key') != '') && (req.get('X-Service-Key') !== cfg.introspectServiceKey))
            throw new AuthError(401, 'unauthorized', 'Invalid service key');
        const { token } = req.body || {};
        if (!isStr(token)) throw new AuthError(400, 'invalid_request', 'token is required');
        res.json(await tokens.introspect(token));
    }));

    app.use((err, req, res, next) => {
        if (err instanceof AuthError)
        return res.status(err.status).json({ error: err.code, error_description: err.message });
        if (err.type === 'entity.parse.failed')
        return res.status(400).json({ error: 'invalid_request', error_description: 'Malformed JSON' });
        log.error({ event: 'unhandled', correlation_id: req.cid, message: err.message });
        res.status(500).json({ error: 'server_error' });
    });

    return app;
}