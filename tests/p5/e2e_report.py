#!/usr/bin/env python3
"""Evaluasi jalur alert kritis (P5 kriteria 1): 0 event kritis hilang, p95 latensi <= 5 detik.

Masukan (semuanya disiapkan oleh 02-critical-e2e.sh):
  --received  JSON-lines dari collector.js (pesan yang BENAR-BENAR sampai ke antrean ber-binding hazard.*.awas)
  --sensor    JSON dari sensor_critical.js (semua observation_id critical=true menurut sensor)
  --db-all    source_ref_id HazardEvent SENSOR_PANTAI berseverity AWAS di seluruh shard (satu per baris)
  --db-window source_ref_id|ingested_at untuk event AWAS yang masuk selama jendela uji
  --rejected  observation_id kritis yang dikarantina validator (satu per baris)
  --pending   jumlah baris critical_outbox yang belum terkirim saat uji selesai
Definisi:
  hilang    = kritis di sensor  - (tersimpan sebagai AWAS)  - (dikarantina)      -> harus 0
  tak sampai = AWAS tersimpan selama jendela  - diterima kolektor                  -> harus 0
  latensi   = waktu diterima kolektor - ingested_at (waktu aggregator memetakan observasi)
"""
import argparse, datetime as dt, json, sys


def parse(ts):
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def pct(vals, p):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(p / 100 * len(s)))]


def lines(path):
    try:
        return [l.strip() for l in open(path, encoding="utf-8") if l.strip()]
    except FileNotFoundError:
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--received", required=True)
    ap.add_argument("--sensor", required=True)
    ap.add_argument("--db-all", required=True)
    ap.add_argument("--db-window", required=True)
    ap.add_argument("--rejected", required=True)
    ap.add_argument("--pending", type=int, default=0)
    ap.add_argument("--p95-max", type=float, default=5.0)
    ap.add_argument("--out")
    a = ap.parse_args()

    recv = []
    for l in lines(a.received):
        try:
            recv.append(json.loads(l))
        except ValueError:
            pass
    sensor = json.load(open(a.sensor)) if lines(a.sensor) else {"critical_ids": []}
    s_ids = set(sensor.get("critical_ids", []))
    db_all = set(lines(a.db_all))
    window = {}
    for l in lines(a.db_window):
        ref, _, ing = l.partition("|")
        window[ref] = ing
    rejected = set(lines(a.rejected))

    recv_ids = {r["source_ref_id"] for r in recv if r.get("source_ref_id")}
    lat = []
    for r in recv:
        if r.get("ingested_at"):
            try:
                lat.append(max(0.0, r["recv_ms"] / 1000 - parse(r["ingested_at"])))
            except ValueError:
                pass
    msg_counts = {}
    for r in recv:
        key = r.get("message_id") or r.get("hazard_id")
        msg_counts[key] = msg_counts.get(key, 0) + 1
    dup_msgs = sum(1 for c in msg_counts.values() if c > 1)

    lost = sorted(s_ids - db_all - rejected)
    undelivered = sorted(set(window) - recv_ids)
    p95 = pct(lat, 95)

    res = {
        "kritis_di_sensor": len(s_ids), "tersimpan_AWAS": len(db_all), "dikarantina_kritis": len(rejected & s_ids),
        "hilang": len(lost), "contoh_hilang": lost[:5],
        "event_AWAS_selama_jendela": len(window), "diterima_kolektor": len(recv), "tak_sampai": len(undelivered),
        "contoh_tak_sampai": undelivered[:5], "pesan_ganda_di_kolektor": dup_msgs, "outbox_belum_terkirim": a.pending,
        "latensi_s": {"n": len(lat), "p50": pct(lat, 50), "p95": p95, "p99": pct(lat, 99), "maks": max(lat) if lat else None},
    }
    checks = [
        ("0 event kritis hilang (sensor - tersimpan - dikarantina)", len(lost) == 0, f"hilang={len(lost)}"),
        ("semua AWAS yang tersimpan sampai ke penerima", len(undelivered) == 0, f"tak sampai={len(undelivered)}"),
        ("outbox kosong di akhir uji", a.pending == 0, f"menunggu={a.pending}"),
    ]
    if lat:
        checks.append((f"p95 latensi <= {a.p95_max}s", p95 <= a.p95_max, f"p95={p95:.3f}s"))
    else:
        checks.append((f"p95 latensi <= {a.p95_max}s", False, "tidak ada pesan terukur (tidak ada alert kritis selama jendela?)"))

    print(json.dumps(res, indent=2, ensure_ascii=False))
    print()
    fail = 0
    for name, ok, detail in checks:
        print(f"  [{'LULUS' if ok else 'GAGAL'}] {name}  ({detail})")
        fail += 0 if ok else 1
    if a.out:
        open(a.out, "w", encoding="utf-8").write(json.dumps(res, indent=2, ensure_ascii=False))
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
