import { jwtVerify } from 'jose';
import { HttpError } from './error.js';
import { callJson } from './http.js'

export function createAuth(cfg){
    return async function auth(req, res, next) {
        const m = /^Bearer (.+)$/i.exec(req.get('Authorization') || '');

        if (!m) throw new HttpError(401, 'invalid_token', 'Missing beraer');
        const token = m[1];

        //verify token

        try{
            await jwtVerify(token, cfg.publicKey, {
                issuer: cfg.issuer, audience: cfg.audience, 'algorithms': ['ES256'],
            });
        } catch{
            throw new HttpError(401, 'invalid_token', 'Invalid Token');
        }

        //verify is seesion active
        let r;
        try{
            r = await callJson('token-service', `${cfg.tokenServiceUrl}/auth/introspect`, {
                method: 'POST',
                headers: {'X-Service-Key': cfg.introspectServiceKey },
                body: {token},
                cid: req.cid,
                timeoutMs: cfg.upstreamTimeoutMs,
            });
        }catch{
            throw new HttpError(503, 'auth_unavailable', 'Cannot verify token right now');
        }

        if (r.status !== 200) throw new HttpError(503, 'auth_unavailable', 'Cannot verify token right now');
        if (!r.data?.active) throw new HttpError(401, 'invalid_token', 'Token is no longer active');

        req.auth = {clientId: r.data.sub, scope: r.data.scope};
        next();
    }
}
