// Mengumpulkan SEMUA observation_id yang ditandai critical=true oleh Sensor Pantai (membaca seluruh halaman).
// Dipakai sebagai "kebenaran dasar" untuk memeriksa bahwa tidak ada event kritis yang hilang.
//   kubectl exec -i deploy/aggregator -- node - < tests/p5/sensor_critical.js
const BASE = process.env.PANTAI_BASE_URL || "http://sensor-pantai:8080";
const TOKEN = process.env.PANTAI_AUTH_TOKEN || "";
(async () => {
  const ids = new Set();
  let total = 0, pages = 0, cursor = null, last = null;
  while (pages < 2000) {
    const q = new URLSearchParams({ limit: "200" });
    if (cursor) q.set("cursor", cursor);
    const r = await fetch(`${BASE}/v1/observations?${q}`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) { console.log(JSON.stringify({ error: `HTTP ${r.status}`, pages })); process.exit(2); }
    const b = await r.json();
    for (const o of b.items || []) { total++; if (o && o.critical === true && typeof o.observation_id === "string") ids.add(o.observation_id); }
    pages++; last = b.generated_at;
    if (!b.next_cursor || b.next_cursor === cursor || !(b.items || []).length) break;
    cursor = b.next_cursor;
  }
  console.log(JSON.stringify({ total_observasi: total, halaman: pages, generated_at_terakhir: last, critical_ids: [...ids] }));
})().catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e) })); process.exit(2); });
