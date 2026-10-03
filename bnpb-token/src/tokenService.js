import { SignJWT, jwtVerify } from 'jose';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
// import { hashSecret, verifySecret } from './crypto.js';
import { hashSecret, verifySecret } from './crypto.js';
export class AuthError extends Error{
    constructor(status, code, desc){
        super(desc);
        this.status = status;
        this.code = code;
    }
}
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function createTokenService({pool, cfg: config, keys}) {
    for (const c of config.clients){
        await pool.query(
      `INSERT INTO clients (client_id, secret_hash, scope) VALUES ($1, $2, $3)
       ON CONFLICT (client_id) DO UPDATE
         SET secret_hash = EXCLUDED.secret_hash, scope = EXCLUDED.scope`,
      [c.clientId, hashSecret(c.clientSecret), c.scope],
    )}
    
    async function signAccessToken({sub, scope, sid}){
        const jti = randomUUID();
        const now =  Math.floor(Date.now() / 1000);
        const token = await new SignJWT({scope, sid})
            .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
            .setIssuer(config.issuer)
            .setAudience(config.audience)
            .setSubject(sub)
            .setJti(jti)
            .setIssuedAt(now)
            .setExpirationTime(now + config.accessTtlSeconds)
            .sign(keys.privateKey);
        
        return {token, jti}
    }

    async function createRefreshToken(pool, sid){
        const token =randomBytes(32).toString('base64url');

        await pool.query(
            `INSERT INTO refresh_tokens (token_hash, sid, expires_at)
            VALUES ($1, $2, now() + $3::int * interval '1 second')`,
            [sha256(token), sid, config.refreshTtlSeconds],
        );

        return token;
    }
    
    const tokenResponse = (access, refresh, scope) => ({
        token_type: 'Bearer',
        access_token: access,
        expires_in: config.accessTtlSeconds,
        refresh_token: refresh,
        refresh_expires_in: config.refreshTtlSeconds,
        scope,
    })

    const  revokeSession = (sid) =>
         pool.query('UPDATE sessions SET revoked = true WHERE sid=$1', [sid])

    async function login(clientId, clientSecret) {
        const { rows: [client] } = await pool.query(
            'SELECT * FROM clients WHERE client_id = $1', [clientId]
        );

        if (!client || !verifySecret(clientSecret, client.secret_hash))
            throw new AuthError(401, 'invalid_client', 'Invalid credentials');
        
        const ok = verifySecret(clientSecret, client.secret_hash);

        if (!ok) throw new AuthError(401, 'invalid_secret', 'Invalid credentials');

        const sid = randomUUID();
        const {token, jti} = await signAccessToken({sub:client.client_id, scope:client.scope, sid});
        await pool.query(
            'INSERT INTO sessions (sid, client_id, scope, current_jti) VALUES ($1, $2, $3, $4)',
            [sid, client.client_id, client.scope, jti]
        );

        const refresh = await createRefreshToken(pool, sid)

        return tokenResponse(token, refresh, client.scope);
    }

    async function refresh(refresh_token) {
        const hash = createHash('sha256').update(refresh_token).digest('hex');
        const { rows: [row] } = await pool.query(
        'SELECT *, (expires_at < now()) AS expired FROM refresh_tokens WHERE token_hash = $1', [hash]);
        
        if (!row) throw new AuthError(401, 'Invalid ref token', 'Invalid refresh token');

        const {rows : [session]} = await pool.query('SELECT * FROM sessions WHERE sid = $1', [row.sid]);
        if (!session || session.revoked) throw new AuthError(401, 'invalid_grant', 'Session revoked');

        if (row.used){
            await revokeSession(row.sid);
            throw new AuthError(401, 'invalid_grant', 'Refresh token reuse detected; session revoked');
        }

        if (row.expired) throw new AuthError(401, 'invalid_grant', 'Refresh token expired');

        const {token, jti} = await signAccessToken({
            sub: session.client_id, scope: session.scope, sid: session.sid
        });

        await pool.query('UPDATE refresh_tokens SET used = true WHERE token_hash = $1 AND used = false', [hash]);
        await pool.query('UPDATE sessions SET current_jti = $1 WHERE sid = $2', [jti, session.sid]);

        const newRefresh = await createRefreshToken(pool, session.sid);

        return tokenResponse(token, newRefresh, session.scope);
    }

    async function introspect(token) {
        let payload;
        try{
            ({ payload } = await jwtVerify(token, keys.publicKey, {
                issuer: config.issuer, audience: config.audience, algorithms: ['ES256'],
            }));
        }catch{
            return {active: false};
        }

        const { rows: [s] } = await pool.query('SELECT * FROM sessions WHERE sid = $1', [payload.sid]);

        if (!s || s.revoked || s.current_jti !== payload.jti) return { active: false };
        
        return {
            active: true, sub: payload.sub, scope: payload.scope,
            sid: payload.sid, jti: payload.jti, exp: payload.exp,
        }
    }

    
    return {login, refresh, introspect}
}