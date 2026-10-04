import {log} from './logger.js';

export async function callJson(name, url, { cid, timeoutMs, method = 'GET', headers, body } = {}) {
  const start = Date.now();
  let status = 0;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', 'X-Correlation-ID': cid, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    return { status, data: await res.json().catch(() => null) };
  } finally {
    log.info({
      event: 'outbound', correlation_id: cid, target: name,
      path: new URL(url).pathname, status, latency_ms: Date.now() - start,
    });
  }
}