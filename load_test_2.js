const HEADERS = { 'content-type': 'application/json' };
let session = null;            // per VU: { access, refresh, expiresAt }

function store(d) {
  session = {
    access: d.access_token,
    refresh: d.refresh_token,
    expiresAt: Date.now() + (d.expires_in - 5) * 1000,   // refresh 5 s early
  };
}

function login() {
  const r = http.post(`${TOKEN_URL}/auth/token`,
    JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    { headers: HEADERS, tags: { endpoint: 'auth' } });
  if (r.status !== 200) return false;
  store(r.json());
  return true;
}

function refresh() {
  const r = http.post(`${TOKEN_URL}/auth/refresh`,
    JSON.stringify({ refresh_token: session.refresh }),
    { headers: HEADERS, tags: { endpoint: 'auth' } });
  if (r.status !== 200) return login();      // fall back to a fresh login
  store(r.json());
  return true;
}

function get(path, endpoint) {
  return http.get(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${session.access}` },
    tags: { endpoint },
  });
}

function hit(path, endpoint) {
  if (!session && !login()) {
    check(null, { 'not a real error': () => false }, { type: 'real_error' });
    return;
  }
  if (Date.now() >= session.expiresAt) refresh();          // proactive refresh

  let r = get(path, endpoint);
  if (r.status === 401) { refresh(); r = get(path, endpoint); }   // safety net

  if (r.status === 429) rejected429.add(1);
  check(r, { 'not a real error': (x) => x.status === 200 || x.status === 429 },
        { type: 'real_error' });
}

export function seismic()  { hit('/data?hazard_type=SEISMIC',  'seismic'); }
export function volcanic() { hit('/data?hazard_type=VOLCANIC', 'volcanic'); }
