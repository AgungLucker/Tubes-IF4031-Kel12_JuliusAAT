// Memindai seluruh HazardEvent lewat Audit API (Lampiran A) dan mencari duplikat.
// Dijalankan DI DALAM pod aggregator (token diambil dari env AUDIT_TOKEN pod itu):
//   kubectl exec -i <pod-aggregator> -- node - < tests/p2/audit_scan.js
// Keluaran: satu baris JSON. Kode keluar 0 = tidak ada duplikat, 1 = ada duplikat, 3 = token kosong.
const BASE = process.env.AUDIT_BASE || "http://localhost:8090";
const TOKEN = process.env.AUDIT_TOKEN;

async function get(path) {
  const r = await fetch(BASE + path, { headers: { authorization: `Bearer ${TOKEN}` } });
  let body = null;
  try { body = await r.json(); } catch { /* bukan JSON */ }
  return { status: r.status, body };
}

(async () => {
  if (!TOKEN) {
    console.log(JSON.stringify({ error: "AUDIT_TOKEN kosong di pod aggregator (Secret aggregator-audit belum diisi)" }));
    process.exit(3);
  }
  const byId = new Map();
  const byRef = new Map();
  const perSource = {};
  const unavailable = new Set();
  let cursor = null, pages = 0, partial = false;
  do {
    const q = new URLSearchParams({ limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const { status, body } = await get(`/internal/audit/events?${q}`);
    if (status !== 200) {
      console.log(JSON.stringify({ error: `HTTP ${status} dari /internal/audit/events`, body }));
      process.exit(2);
    }
    for (const e of body.items) {
      byId.set(e.hazard_id, (byId.get(e.hazard_id) || 0) + 1);
      const ref = `${e.source}|${e.source_ref_id}`;
      byRef.set(ref, (byRef.get(ref) || 0) + 1);
      perSource[e.source] = (perSource[e.source] || 0) + 1;
    }
    partial = partial || !!body.partial;
    (body.unavailable_units || []).forEach((u) => unavailable.add(u));
    cursor = body.next_cursor;
    pages++;
  } while (cursor && pages < 5000);

  const dupIds = [...byId.entries()].filter(([, c]) => c > 1).map(([k]) => k);
  const dupRefs = [...byRef.entries()].filter(([, c]) => c > 1).map(([k]) => k);

  const checksums = {};
  for (const s of Object.keys(perSource)) {
    const { status, body } = await get(`/internal/audit/checksum?source=${encodeURIComponent(s)}`);
    checksums[s] = status === 200
      ? { count: body.count, checksum: body.checksum, partial: !!body.partial, count_matches_scan: body.count === perSource[s] }
      : { error: `HTTP ${status}` };
  }

  const out = {
    total: byId.size, pages, per_source: perSource,
    duplicate_hazard_ids: dupIds.length, duplicate_source_refs: dupRefs.length,
    sample_duplicates: dupRefs.slice(0, 5),
    partial, unavailable_units: [...unavailable], checksums,
  };
  console.log(JSON.stringify(out));
  process.exit(dupIds.length || dupRefs.length ? 1 : 0);
})().catch((e) => { console.log(JSON.stringify({ error: String(e && e.message || e) })); process.exit(2); });
