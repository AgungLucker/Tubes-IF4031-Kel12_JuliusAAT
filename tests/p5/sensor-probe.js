// Probe perilaku Sensor Pantai: mengkatalogkan penyimpangan terhadap kontrak dasar (Lampiran C) untuk
// laporan P5 bagian 3 ("perilaku menyimpang, cara menemukan, cara menangani").
// Dijalankan DI DALAM pod aggregator (token dan alamat sensor sudah ada di env pod itu):
//   kubectl exec -i deploy/aggregator -- env DURATION_S=120 node - < tests/p5/sensor-probe.js > laporan.json
// Tidak mengubah apa pun di sensor (hanya GET). Tidak bergantung pada ID, seed, atau pola profil latihan:
// hanya memeriksa bentuk, tipe, rentang, urutan, kesegaran, dan perilaku HTTP.
const BASE = process.env.PANTAI_BASE_URL || "http://sensor-pantai:8080";
const TOKEN = process.env.PANTAI_AUTH_TOKEN || "";
const DURATION_S = Number(process.env.DURATION_S || 120);
const INTERVAL_MS = Number(process.env.INTERVAL_MS || 1000);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 5000);
const PAGE_LIMIT = Number(process.env.PAGE_LIMIT || 200);
const MAX_BACKLOG_PAGES = Number(process.env.MAX_BACKLOG_PAGES || 50);
const STALE_S = Number(process.env.STALE_S || 900);

const found = {};       // id -> {count, contoh}
function note(id, detail) {
  if (!found[id]) found[id] = { count: 0, contoh: detail };
  found[id].count++;
}
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const pct = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

async function req(path, { auth = true, token = TOKEN } = {}) {
  const t = Date.now();
  try {
    const r = await fetch(BASE + path, {
      headers: auth ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await r.text();
    let body = null, json = true;
    try { body = JSON.parse(raw); } catch { json = false; }
    return { status: r.status, ms: Date.now() - t, raw, body, json, ct: r.headers.get("content-type") || "" };
  } catch (e) {
    return { status: 0, ms: Date.now() - t, error: e.name === "TimeoutError" ? "timeout" : String(e.message || e) };
  }
}

const stationIds = new Set();
async function checkStations() {
  const r = await req("/v1/stations");
  if (r.status !== 200 || !r.json) { note("stations_tidak_terbaca", `HTTP ${r.status} ${r.error || ""}`); return; }
  const items = r.body?.items;
  if (!Array.isArray(items)) { note("stations_tanpa_items", JSON.stringify(r.body).slice(0, 100)); return; }
  const seen = new Set();
  for (const s of items) {
    if (!s || typeof s.station_id !== "string" || !s.station_id) { note("station_id_tidak_valid", JSON.stringify(s)); continue; }
    if (seen.has(s.station_id)) note("station_id_ganda", s.station_id);
    seen.add(s.station_id); stationIds.add(s.station_id);
    if (!isNum(s.latitude) || Math.abs(s.latitude) > 90) note("station_latitude_tidak_valid", JSON.stringify(s));
    if (!isNum(s.longitude) || Math.abs(s.longitude) > 180) note("station_longitude_tidak_valid", JSON.stringify(s));
    if (typeof s.name !== "string" || !s.name) note("station_tanpa_nama", s.station_id);
  }
  return items.length;
}

const seenObs = new Map();            // observation_id -> ringkasan isi (untuk mendeteksi isi berubah)
const qualityHist = {};
const critSea = { true: [], false: [] };
const critWave = { true: [], false: [] };
let totalItems = 0, criticalItems = 0;

function checkObservation(o, generatedMs, where) {
  totalItems++;
  if (o === null || typeof o !== "object" || Array.isArray(o)) { note("observasi_bukan_objek", JSON.stringify(o)); return; }
  for (const f of ["observation_id", "station_id", "observed_at", "sea_level_anomaly_m", "wave_height_m", "quality", "critical"]) {
    if (!(f in o)) note(`field_hilang:${f}`, JSON.stringify(o).slice(0, 140));
  }
  if (typeof o.observation_id !== "string" || !o.observation_id) note("observation_id_tidak_valid", JSON.stringify(o.observation_id));
  if ("station_id" in o && (typeof o.station_id !== "string" || !o.station_id)) note("station_id_observasi_tidak_valid", JSON.stringify(o.station_id));
  else if (stationIds.size && o.station_id && !stationIds.has(o.station_id)) note("station_tidak_dikenal", o.station_id);
  if ("observed_at" in o) {
    if (typeof o.observed_at !== "string" || !ISO.test(o.observed_at)) note("observed_at_bukan_iso8601", JSON.stringify(o.observed_at));
    else if (generatedMs && Date.parse(o.observed_at) > generatedMs + 1000) note("observed_at_lebih_baru_dari_generated_at", `${o.observed_at} > ${new Date(generatedMs).toISOString()}`);
  }
  for (const f of ["sea_level_anomaly_m", "wave_height_m"]) {
    if (f in o && !isNum(o[f])) note(`${f}_bukan_angka`, `${typeof o[f]}:${JSON.stringify(o[f])}`);
  }
  if (isNum(o.sea_level_anomaly_m) && Math.abs(o.sea_level_anomaly_m) > 30) note("sea_level_di_luar_rentang_fisik", String(o.sea_level_anomaly_m));
  if (isNum(o.wave_height_m) && (o.wave_height_m < 0 || o.wave_height_m > 60)) note("wave_height_di_luar_rentang_fisik", String(o.wave_height_m));
  if ("critical" in o && typeof o.critical !== "boolean") note("critical_bukan_boolean", JSON.stringify(o.critical));
  if ("quality" in o) {
    qualityHist[String(o.quality)] = (qualityHist[String(o.quality)] || 0) + 1;
    if (typeof o.quality !== "string") note("quality_bukan_string", JSON.stringify(o.quality));
  }
  if (typeof o.critical === "boolean") {
    if (o.critical) criticalItems++;
    if (isNum(o.sea_level_anomaly_m)) critSea[o.critical].push(Math.abs(o.sea_level_anomaly_m));
    if (isNum(o.wave_height_m)) critWave[o.critical].push(o.wave_height_m);
  }
  const key = JSON.stringify([o.station_id, o.observed_at, o.sea_level_anomaly_m, o.wave_height_m, o.quality, o.critical]);
  if (typeof o.observation_id === "string") {
    if (seenObs.has(o.observation_id)) {
      if (seenObs.get(o.observation_id) !== key) note("observation_id_sama_isi_berbeda", `${o.observation_id} (${where})`);
      else note("observasi_dikirim_ulang_identik", o.observation_id);
    } else seenObs.set(o.observation_id, key);
  }
}

function checkOrder(items, where) {
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1], b = items[i];
    if (!a?.observed_at || !b?.observed_at) continue;
    if (a.observed_at > b.observed_at || (a.observed_at === b.observed_at && String(a.observation_id) > String(b.observation_id))) {
      note("urutan_tidak_sesuai_kontrak", `${a.observation_id}@${a.observed_at} sebelum ${b.observation_id}@${b.observed_at} (${where})`);
      return;
    }
  }
}

async function backlog() {
  let cursor = null, pages = 0, last = null;
  const sizes = [];
  while (pages < MAX_BACKLOG_PAGES) {
    const q = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) q.set("cursor", cursor);
    const r = await req(`/v1/observations?${q}`);
    if (r.status !== 200 || !r.json) { note("backlog_halaman_gagal", `HTTP ${r.status} ${r.error || (r.json ? "" : "bukan JSON")}`); break; }
    const body = r.body;
    if (!Array.isArray(body.items)) { note("backlog_tanpa_items", JSON.stringify(body).slice(0, 100)); break; }
    const gen = Date.parse(body.generated_at);
    if (Number.isNaN(gen)) note("generated_at_tidak_valid", String(body.generated_at));
    sizes.push(body.items.length);
    checkOrder(body.items, "backlog");
    body.items.forEach((o) => checkObservation(o, Number.isNaN(gen) ? null : gen, "backlog"));
    pages++;
    if (!body.next_cursor) { last = "next_cursor null"; break; }
    if (body.next_cursor === cursor) { note("cursor_tidak_maju", String(cursor)); last = "cursor tidak maju"; break; }
    if (body.items.length === 0) { note("halaman_kosong_dengan_next_cursor", String(body.next_cursor)); }
    cursor = body.next_cursor;
  }
  return { pages, sizes, berhenti: last || "batas halaman", cursor };
}

async function live(cursorStart) {
  const lat = [], itemsPerPoll = [], lags = [], skew = [];
  const statuses = {};
  let cursor = cursorStart, polls = 0, stale = 0, bursts = 0, empty = 0, fails = 0, consecFail = 0, maxConsecFail = 0;
  const end = Date.now() + DURATION_S * 1000;
  while (Date.now() < end) {
    const q = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (cursor) q.set("cursor", cursor);
    const r = await req(`/v1/observations?${q}`);
    polls++;
    const sk = r.status === 0 ? (r.error || "error") : r.status;
    statuses[sk] = (statuses[sk] || 0) + 1;
    lat.push(r.ms);
    if (r.status !== 200) { fails++; consecFail++; maxConsecFail = Math.max(maxConsecFail, consecFail); }
    else if (!r.json) { fails++; consecFail++; note("badan_bukan_json_atau_terpotong", r.raw.slice(0, 80)); }
    else if (!Array.isArray(r.body?.items)) { fails++; note("respons_tanpa_items", r.raw.slice(0, 80)); }
    else {
      consecFail = 0;
      const gen = Date.parse(r.body.generated_at);
      const items = r.body.items;
      itemsPerPoll.push(items.length);
      if (items.length === 0) empty++;
      if (items.length >= 50) { bursts++; }
      checkOrder(items, "live");
      items.forEach((o) => checkObservation(o, Number.isNaN(gen) ? null : gen, "live"));
      if (!Number.isNaN(gen)) {
        skew.push(Math.round((gen - Date.now()) / 1000));
        const newest = Math.max(...items.map((o) => Date.parse(o?.observed_at)).filter(Number.isFinite), -Infinity);
        if (Number.isFinite(newest)) {
          const lag = (gen - newest) / 1000; lags.push(lag);
          if (lag > STALE_S) { stale++; note("data_basi_walau_http_200", `generated_at - observed_at terbaru = ${Math.round(lag)}s`); }
        }
      } else note("generated_at_tidak_valid", String(r.body.generated_at));
      if (r.body.next_cursor && r.body.next_cursor !== cursor) cursor = r.body.next_cursor;
    }
    if (r.ms > 2000) note("respons_lambat_lebih_dari_2s", `${r.ms}ms`);
    const wait = INTERVAL_MS - r.ms; if (wait > 0) await new Promise((x) => setTimeout(x, wait));
  }
  return {
    polls, gagal: fails, gagal_beruntun_maks: maxConsecFail, status: statuses,
    latensi_ms: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), maks: Math.max(...lat) },
    item_per_poll: { p50: pct(itemsPerPoll, 50), p95: pct(itemsPerPoll, 95), maks: itemsPerPoll.length ? Math.max(...itemsPerPoll) : null, poll_kosong: empty, poll_burst_ge_50: bursts },
    lag_generated_vs_observed_s: { p50: pct(lags, 50), p95: pct(lags, 95), maks: lags.length ? Math.max(...lags) : null, poll_basi: stale },
    selisih_generated_at_vs_jam_lokal_s: { p50: pct(skew, 50), min: skew.length ? Math.min(...skew) : null, maks: skew.length ? Math.max(...skew) : null },
  };
}

(async () => {
  const report = { dimulai: new Date().toISOString(), sensor: BASE, durasi_s: DURATION_S };
  // 1) Otentikasi
  const noTok = await req("/v1/stations", { auth: false });
  const badTok = await req("/v1/stations", { token: "token-salah-" + Date.now() });
  report.otentikasi = { tanpa_token: noTok.status, token_salah: badTok.status };
  if (noTok.status !== 401) note("otentikasi_tanpa_token_tidak_401", `HTTP ${noTok.status}`);
  if (badTok.status !== 401) note("otentikasi_token_salah_tidak_401", `HTTP ${badTok.status}`);
  // 2) healthz (10 kali)
  const hz = [];
  for (let i = 0; i < 10; i++) { const r = await req("/healthz", { auth: false }); hz.push(r.status); if (r.status !== 200) note("healthz_bukan_200", `HTTP ${r.status}`); await new Promise((x) => setTimeout(x, 200)); }
  report.healthz = hz;
  // 3) stations, backlog, live
  report.stations = await checkStations();
  report.backlog = await backlog();
  report.live = await live(report.backlog.cursor);
  report.total_observasi_diperiksa = totalItems;
  report.observasi_kritis = criticalItems;
  report.quality = qualityHist;
  const rng = (a) => a.length ? { min: Math.min(...a), maks: Math.max(...a), n: a.length } : null;
  report.sebaran_nilai = {
    sea_level_abs_kritis: rng(critSea.true), sea_level_abs_tidak_kritis: rng(critSea.false),
    wave_kritis: rng(critWave.true), wave_tidak_kritis: rng(critWave.false),
  };
  if (critSea.true.length && critSea.false.length) {
    const minCrit = Math.min(...critSea.true), maxNon = Math.max(...critSea.false);
    if (minCrit < maxNon) note("flag_critical_tidak_konsisten_dengan_besaran", `critical=true mulai ${minCrit} m, sedangkan critical=false mencapai ${maxNon} m`);
  }
  for (const q of Object.keys(qualityHist)) if (q !== "ok") note(`quality_selain_ok:${q}`, `${qualityHist[q]} observasi`);
  report.penyimpangan = Object.entries(found).map(([id, v]) => ({ id, jumlah: v.count, contoh: v.contoh }))
    .sort((a, b) => b.jumlah - a.jumlah);
  report.selesai = new Date().toISOString();
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e) })); process.exit(1); });
