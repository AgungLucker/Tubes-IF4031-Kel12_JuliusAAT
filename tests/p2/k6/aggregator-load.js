// P2 kriteria 6 dan 8: beban berkelanjutan (>= 10.000 VU, >= 120 detik) pada titik masuk aggregator
// selama jumlah instance diubah (3 -> 5 -> 2) atau versi diganti.
//
// Dua mode (env MODE):
//   direct  (bawaan)  GET langsung ke Service aggregator (BASE=http://aggregator:8090). Rate limit aggregator
//                     berlaku per IP, jadi naikkan RATE_LIMIT_PER_SEC dulu (skrip 06 melakukannya otomatis).
//   client            lewat client-service dengan JWT (jalur nyata sistem): BASE=http://client-service:8080,
//                     TOKEN_URL=http://bnpb-token-service:8090, CLIENT_ID/CLIENT_SECRET (Media atau Lapangan).
//
// Penolakan 429 adalah penolakan terkendali: dihitung terpisah, bukan error. Kriteria lulus bila
//   real_errors < 1% (6) atau 0 (8, rolling update tanpa permintaan gagal).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const MODE = __ENV.MODE || 'direct';
const BASE = __ENV.BASE || (MODE === 'client' ? 'http://client-service:8080' : 'http://aggregator:8090');
const TOKEN_URL = __ENV.TOKEN_URL || 'http://bnpb-token-service:8090';
const VUS = Number(__ENV.VUS || 10000);
const RAMP = __ENV.RAMP || '30s';
const DURATION = __ENV.DURATION || '180s';
const THINK_S = Number(__ENV.THINK_S || 5);          // jeda per VU; laju permintaan ~ VUS / THINK_S
const MAX_ERR_RATE = Number(__ENV.MAX_ERR_RATE || 0.01);

const rejected429 = new Counter('rejected_429');
const realErrors = new Counter('real_errors');
const realErrorRate = new Rate('real_error_rate');

export const options = {
  scenarios: {
    sustained: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '15s',
    },
  },
  thresholds: {
    real_error_rate: [`rate<${MAX_ERR_RATE}`],
    ...(MAX_ERR_RATE === 0 ? { real_errors: ['count<1'] } : {}),
    http_req_duration: ['p(95)<3000'],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

const PATHS = [
  '/hazard-events?hazard_type=SEISMIC&limit=20',
  '/hazard-events?hazard_type=VOLCANIC&limit=20',
  '/hazard-events?limit=20',
];
const CLIENT_PATHS = ['/data?hazard_type=SEISMIC', '/data?hazard_type=VOLCANIC', '/data?hazard_type=COASTAL'];

let session = null;
function login() {
  const r = http.post(`${TOKEN_URL}/auth/token`,
    JSON.stringify({ client_id: __ENV.CLIENT_ID, client_secret: __ENV.CLIENT_SECRET }),
    { headers: { 'content-type': 'application/json' }, tags: { endpoint: 'auth' } });
  if (r.status === 200) { const d = r.json(); session = { access: d.access_token, refresh: d.refresh_token }; return true; }
  return false;
}
function refresh() {
  const r = http.post(`${TOKEN_URL}/auth/refresh`, JSON.stringify({ refresh_token: session.refresh }),
    { headers: { 'content-type': 'application/json' }, tags: { endpoint: 'auth' } });
  if (r.status === 200) { const d = r.json(); session = { access: d.access_token, refresh: d.refresh_token }; return true; }
  return login();
}

export default function () {
  let res;
  if (MODE === 'client') {
    if (!session && !login()) { realErrors.add(1); realErrorRate.add(true); sleep(THINK_S); return; }
    const path = CLIENT_PATHS[Math.floor(Math.random() * CLIENT_PATHS.length)];
    const get = () => http.get(`${BASE}${path}`, { headers: { authorization: `Bearer ${session.access}` }, timeout: '15s', tags: { endpoint: 'data' } });
    res = get();
    if (res.status === 401) { refresh(); res = get(); }
  } else {
    res = http.get(`${BASE}${PATHS[Math.floor(Math.random() * PATHS.length)]}`, { timeout: '15s', tags: { endpoint: 'aggregator' } });
  }
  if (res.status === 429) {
    rejected429.add(1);                                // penolakan terkendali
  } else {
    const okay = check(res, { 'status 200': (r) => r.status === 200 });
    realErrorRate.add(!okay);
    if (!okay) realErrors.add(1);
  }
  sleep(THINK_S * (0.5 + Math.random()));
}

export function handleSummary(data) {
  const m = data.metrics;
  const line = {
    vus_max: m.vus_max ? m.vus_max.values.max : null,
    requests: m.http_reqs ? m.http_reqs.values.count : 0,
    rps: m.http_reqs ? Math.round(m.http_reqs.values.rate * 10) / 10 : 0,
    real_errors: m.real_errors ? m.real_errors.values.count : 0,
    real_error_rate: m.real_error_rate ? m.real_error_rate.values.rate : 0,
    rejected_429: m.rejected_429 ? m.rejected_429.values.count : 0,
    p95_ms: m.http_req_duration ? Math.round(m.http_req_duration.values['p(95)']) : null,
  };
  return { stdout: `\nSUMMARY_JSON ${JSON.stringify(line)}\n` };
}
