// Probe beban/latensi untuk client-service. Dijalankan DI DALAM pod client-service:
//   kubectl exec -i deploy/client-service -- env CLIENT_ID=.. CLIENT_SECRET=.. RPS=20 SECS=30 \
//       PATHS="/data?hazard_type=COASTAL" LABEL=lapangan node - < tests/probe.js
// Mencetak satu baris JSON berisi: jumlah permintaan, distribusi status, latensi (p50/p95/p99/max,
// hanya untuk jawaban 200), garis waktu per detik, dan source_status terakhir untuk COASTAL.
// Tanpa dependensi (memakai fetch bawaan Node).
const env = process.env;
const TOKEN_URL = env.TOKEN_URL || "http://bnpb-token-service:8090";
const BASE = env.BASE || "http://localhost:8080";
const RPS = Number(env.RPS || 10);
const SECS = Number(env.SECS || 30);
const PATHS = (env.PATHS || "/data?hazard_type=SEISMIC").split(",").filter(Boolean);
const LABEL = env.LABEL || "probe";
const TIMEOUT_MS = Number(env.TIMEOUT_MS || 10000);

let session = null;
let loginPromise = null;
const headersJson = { "content-type": "application/json" };

async function login() {
  const r = await fetch(`${TOKEN_URL}/auth/token`, {
    method: "POST", headers: headersJson,
    body: JSON.stringify({ client_id: env.CLIENT_ID, client_secret: env.CLIENT_SECRET }),
  });
  if (!r.ok) throw new Error(`login gagal: HTTP ${r.status}`);
  const d = await r.json();
  session = { access: d.access_token, refresh: d.refresh_token };
}
async function reauth() {
  if (!loginPromise) {
    loginPromise = (async () => {
      try {
        if (session?.refresh) {
          const r = await fetch(`${TOKEN_URL}/auth/refresh`, {
            method: "POST", headers: headersJson, body: JSON.stringify({ refresh_token: session.refresh }),
          });
          if (r.ok) { const d = await r.json(); session = { access: d.access_token, refresh: d.refresh_token }; return; }
        }
        await login();
      } finally { loginPromise = null; }
    })();
  }
  return loginPromise;
}

const statuses = {};
const lat = [];
const perSecond = new Map(); // detik ke-n -> {n, ok, shed, err, lat[]}
let netErrors = 0, retryAfterSeen = 0, sent = 0, inflight = 0;
const sourceStatuses = new Set();
let partialSeen = false;
const t0 = Date.now();

function bucket(ms) {
  const s = Math.floor((ms - t0) / 1000);
  if (!perSecond.has(s)) perSecond.set(s, { n: 0, ok: 0, shed: 0, err: 0, lat: [] });
  return perSecond.get(s);
}
const pct = (arr, p) => {
  if (!arr.length) return null;
  const a = [...arr].sort((x, y) => x - y);
  return Math.round(a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] * 10) / 10;
};

async function one(path) {
  const start = Date.now();
  const b = bucket(start);
  b.n++; sent++; inflight++;
  try {
    let r = await fetch(`${BASE}${path}`, {
      headers: { authorization: `Bearer ${session.access}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status === 401) {
      await reauth();
      r = await fetch(`${BASE}${path}`, {
        headers: { authorization: `Bearer ${session.access}` }, signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    }
    const ms = Date.now() - start;
    statuses[r.status] = (statuses[r.status] || 0) + 1;
    if (r.status === 200) {
      b.ok++; lat.push(ms); b.lat.push(ms);
      try {
        const body = await r.json();
        const ss = body?.source_status?.SENSOR_PANTAI;
        if (ss) sourceStatuses.add(typeof ss === "string" ? ss : ss.status);
        if (body?.partial) partialSeen = true;
      } catch { /* badan bukan JSON: dihitung sebagai 200 saja */ }
    } else {
      await r.arrayBuffer().catch(() => {});
      if (r.status === 429) { b.shed++; if (r.headers.get("retry-after")) retryAfterSeen++; }
      else b.err++;
    }
  } catch {
    netErrors++; b.err++;
  } finally { inflight--; }
}

(async () => {
  await login();
  const tick = 100; // ms
  const perTick = Math.max(1, Math.round((RPS * tick) / 1000));
  const every = RPS * tick / 1000 >= 1 ? tick : Math.round(1000 / RPS);
  let i = 0;
  const timer = setInterval(() => {
    if (Date.now() - t0 >= SECS * 1000) return;
    for (let j = 0; j < (every === tick ? perTick : 1); j++) one(PATHS[i++ % PATHS.length]);
  }, every);
  await new Promise((r) => setTimeout(r, SECS * 1000));
  clearInterval(timer);
  const deadline = Date.now() + TIMEOUT_MS + 2000;
  while (inflight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));

  const timeline = [...perSecond.entries()].sort((a, b) => a[0] - b[0]).map(([t, v]) => ({
    t, n: v.n, ok: v.ok, shed: v.shed, err: v.err, p95: pct(v.lat, 95),
  }));
  console.log(JSON.stringify({
    label: LABEL, rps_target: RPS, seconds: SECS, sent,
    statuses, network_errors: netErrors, retry_after_seen: retryAfterSeen,
    non_ok_non_shed: Object.entries(statuses).filter(([s]) => s !== "200" && s !== "429").reduce((a, [, c]) => a + c, 0) + netErrors,
    latency_ms: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: lat.length ? Math.max(...lat) : null },
    sensor_status_seen: [...sourceStatuses], partial_seen: partialSeen, timeline,
  }));
})().catch((e) => { console.log(JSON.stringify({ label: LABEL, fatal: String(e && e.message || e) })); process.exit(1); });
