// usage: node sim-client.mjs <media|lapangan|internal> [fields]
// creds come from the environment, e.g. MEDIA_CLIENT_ID / MEDIA_CLIENT_SECRET
const TOKEN_URL = process.env.TOKEN_URL || 'http://localhost:8090';
const API_URL = process.env.API_URL || 'http://localhost:8080';
const POLL_MS = Number(process.env.POLL_MS || 5000);

const who = (process.argv[2] || 'media').toUpperCase();
const fields = process.argv[3]; // optional, e.g. latitude,longitude
const id = process.env[`${who}_CLIENT_ID`];
const secret = process.env[`${who}_CLIENT_SECRET`];
if (!id || !secret) { console.error(`Set ${who}_CLIENT_ID and ${who}_CLIENT_SECRET`); process.exit(1); }

let access, refresh;
const ts = () => new Date().toISOString().slice(11, 19);

async function post(path, body) {
  const r = await fetch(TOKEN_URL + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function login() {
  const r = await post('/auth/token', { client_id: id, client_secret: secret });
  if (r.status !== 200) throw new Error(`login failed ${r.status} ${JSON.stringify(r.data)}`);
  ({ access_token: access, refresh_token: refresh } = r.data);
  console.log(`${ts()} LOGIN ok scope=${r.data.scope} ttl=${r.data.expires_in}s`);
}

async function doRefresh() {
  const r = await post('/auth/refresh', { refresh_token: refresh });
  if (r.status !== 200) throw new Error(`refresh failed ${r.status} ${JSON.stringify(r.data)}`);
  ({ access_token: access, refresh_token: refresh } = r.data);
  console.log(`${ts()} REFRESH ok (no manual login)`);
}

async function getData() {
  const qs = fields ? `?fields=${fields}` : '';
  return fetch(`${API_URL}/data${qs}`, { headers: { Authorization: `Bearer ${access}` } });
}

async function tick() {
  let r = await getData();
  if (r.status === 401) {                 // expired or superseded -> refresh, retry once
    console.log(`${ts()} 401 token rejected, refreshing`);
    await doRefresh();
    r = await getData();
  }
  const body = await r.json().catch(() => null);
  if (r.status === 200) {
    const first = body.data[0];
    console.log(`${ts()} GET /data 200 rows=${body.data.length} stale=${body.stale_since ?? '-'} keys=${first ? Object.keys(first).join(',') : '-'}`);
  } else {
    console.log(`${ts()} GET /data ${r.status}`, body);
  }
}

await login();
await tick();
setInterval(() => tick().catch((e) => console.error(`${ts()} ERROR`, e.message)), POLL_MS);
