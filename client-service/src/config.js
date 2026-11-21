import fs from 'node:fs';
import { createPublicKey } from 'node:crypto';

export function loadConfig(env = process.env) {
  return {
    port: parseInt(env.PORT || '8080', 10),
    issuer: env.JWT_ISSUER || 'bnpb-token-service',
    audience: env.JWT_AUDIENCE || 'bnpb-client-api',
    publicKey: createPublicKey(fs.readFileSync(env.JWT_PUBLIC_KEY_FILE)),
    tokenServiceUrl: env.TOKEN_SERVICE_URL,
    introspectServiceKey: env.INTROSPECT_SERVICE_KEY,
    aggregatorUrl: env.AGGREGATOR_URL,
    internalClientId: env.INTERNAL_CLIENT_ID,
    lapanganClientId: env.LAPANGAN_CLIENT_ID || "lapangan-client",
    maxInflight: parseInt(env.CLIENT_MAX_INFLIGHT || "200", 10),
    mediaShare: parseFloat(env.CLIENT_MEDIA_SHARE || "0.6"),
    upstreamTimeoutMs: parseInt(env.UPSTREAM_TIMEOUT_MS || '3000', 10),
  };
}