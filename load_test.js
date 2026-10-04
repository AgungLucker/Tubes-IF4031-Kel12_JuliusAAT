import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const rejected429 = new Counter('rejected_429');

const BASE = __ENV.BASE || 'http://localhost:8080'
const TOKEN_URL = __ENV.TOKEN_URL || 'http://localhost:8090';  
const CLIENT_ID = __ENV.MEDIA_CLIENT_ID;
const CLIENT_SECRET = __ENV.MEDIA_CLIENT_SECRET;

export function setup() {
  const r = http.post(`${TOKEN_URL}/auth/token`,
    JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    { headers: { 'content-type': 'application/json' } });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${r.body}`);
  const d = r.json();
  console.log(`LOGIN ok scope=${d.scope} ttl=${d.expires_in}s`);
  return { access: d.access_token };         
}

export const options = {
  scenarios: {
    seismic:  { executor: 'constant-vus', vus: 25, duration: '60s', exec: 'seismic'  },
    volcanic: { executor: 'constant-vus', vus: 25, duration: '60s', exec: 'volcanic' },
  },
  thresholds: {
    'http_req_duration{endpoint:seismic}': ['p(95)<300'],      // kriteria 1
    'checks{type:real_error}': ['rate>0.99'],                  // kriteria 2 (error < 1%)
  },
  summaryTrendStats: ['avg','med','p(95)','p(99)','max'],
};

function hit(path, endpoint, access) {
  const r = http.get(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${access}` },
    tags: { endpoint },
  });
  if (r.status === 429) rejected429.add(1);
  check(r, { 'not a real error': (x) => x.status === 200 || x.status === 429 },
        { type: 'real_error' });
}

export function seismic(data)  { hit('/data?hazard_type=SEISMIC',  'seismic',  data.access); }
export function volcanic(data) { hit('/data?hazard_type=VOLCANIC', 'volcanic', data.access); }