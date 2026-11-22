#!/usr/bin/env python3
"""Laporan SLO jalur peringatan Tim Lapangan (P5 kriteria 8) dari metrik Prometheus.

Menjawab: "seberapa jauh target keandalan terpakai selama game day?"
SLI/SLO yang dihitung (ubah lewat argumen):
  - Ketersediaan pengiriman: >= 99,9% alert kritis diterbitkan ke broker dan sampai ke penerima (target 0 hilang).
  - Latensi: p95 waktu dari diterima aggregator sampai dikonfirmasi broker <= 5 detik (batas total p95 <= 5 s).
Error budget = (1 - target) x jumlah alert kritis. "Buruk" = alert yang belum diterbitkan + alert yang terbit lebih dari
batas latensi. Dengan target 99,9% dan hanya beberapa alert, anggaran bisa kurang dari 1 event: artinya satu alert
buruk saja sudah menghabiskan anggaran; laporkan angka mentahnya, jangan hanya persennya.

Pemakaian:  python3 slo_report.py --window 1800 [--target 0.999] [--latency 5] [--ns NAMESPACE] [--out slo.md]
"""
import argparse, json, subprocess, sys, urllib.parse


def prom(ns, q):
    url = "http://localhost:9090/api/v1/query?query=" + urllib.parse.quote(q)
    r = subprocess.run(["kubectl", "-n", ns, "exec", "deploy/prometheus", "--", "wget", "-qO-", url],
                       capture_output=True, text=True)
    try:
        return json.loads(r.stdout)["data"]["result"]
    except Exception:
        return []


def scalar(ns, q, default=0.0):
    res = prom(ns, q)
    try:
        v = float(res[0]["value"][1])
        return default if v != v else v  # NaN
    except Exception:
        return default


def by_label(ns, q, label):
    out = {}
    for r in prom(ns, q):
        try:
            out[r["metric"].get(label, "?")] = float(r["value"][1])
        except Exception:
            pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--window", type=int, default=3600, help="lama jendela dalam detik")
    ap.add_argument("--target", type=float, default=0.999)
    ap.add_argument("--latency", type=float, default=5.0)
    ap.add_argument("--ns", default="sistem-informasi-kebencanaan-bnpb")
    ap.add_argument("--out")
    a = ap.parse_args()
    W, ns = f"{a.window}s", a.ns

    crit = scalar(ns, f"sum(increase(pantai_critical_total[{W}]))")
    pub = scalar(ns, f"sum(increase(critical_alerts_published_total[{W}]))")
    pub_fail = scalar(ns, f"sum(increase(critical_alert_publish_failures_total[{W}]))")
    pend_max = scalar(ns, f"max(max_over_time(critical_outbox_pending[{W}]))")
    old_max = scalar(ns, f"max(max_over_time(critical_outbox_oldest_seconds[{W}]))")
    hist = "sum by (le) (increase(critical_alert_publish_seconds_bucket[%s]))" % W
    p50 = scalar(ns, f"histogram_quantile(0.5, {hist})")
    p95 = scalar(ns, f"histogram_quantile(0.95, {hist})")
    p99 = scalar(ns, f"histogram_quantile(0.99, {hist})")
    n_hist = scalar(ns, f"sum(increase(critical_alert_publish_seconds_count[{W}]))")
    within = scalar(ns, f'sum(increase(critical_alert_publish_seconds_bucket{{le="{a.latency:g}"}}[{W}]))')
    late = max(0.0, n_hist - within) if n_hist else 0.0
    undelivered = max(0.0, crit - pub)
    bad = undelivered + late
    budget = (1 - a.target) * crit
    shed = by_label(ns, f"sum by (priority) (increase(client_service_shed_total[{W}]))", "priority")
    trans = by_label(ns, f"sum by (to) (increase(pantai_breaker_transitions_total[{W}]))", "to")
    rej = by_label(ns, f"sum by (reason) (increase(pantai_rejected_total[{W}]))", "reason")
    req = by_label(ns, f"sum by (outcome) (increase(pantai_upstream_requests_total[{W}]))", "outcome")
    skipped = scalar(ns, f"sum(increase(pantai_upstream_skipped_total[{W}]))")
    ready_min = scalar(ns, f"min(min_over_time(aggregator_ready[{W}]))", default=float("nan"))
    ready_avg = scalar(ns, f"avg(avg_over_time(aggregator_ready[{W}]))", default=float("nan"))

    L = []
    L.append(f"# Laporan SLO jalur peringatan Tim Lapangan (jendela {a.window} detik)\n")
    L.append("## Target\n")
    L.append(f"- Ketersediaan pengiriman alert kritis: >= {a.target*100:.2f}% (0 hilang)")
    L.append(f"- Latensi: p95 <= {a.latency:g} detik (diterima aggregator sampai dikonfirmasi broker)\n")
    L.append("## Hasil\n")
    L.append("| Indikator | Nilai |\n|---|---|")
    L.append(f"| Alert kritis diterima dari sensor | {crit:.0f} |")
    L.append(f"| Alert kritis diterbitkan (dikonfirmasi broker) | {pub:.0f} |")
    L.append(f"| Percobaan publish gagal (alert tetap di outbox lalu dicoba lagi) | {pub_fail:.0f} |")
    L.append(f"| Outbox menunggu, puncak | {pend_max:.0f} |")
    L.append(f"| Umur alert tertua yang belum terkirim, puncak (detik) | {old_max:.1f} |")
    L.append(f"| Latensi p50 / p95 / p99 (detik) | {p50:.3f} / {p95:.3f} / {p99:.3f} |")
    L.append(f"| Alert terbit lebih lambat dari {a.latency:g} s | {late:.0f} dari {n_hist:.0f} |")
    L.append(f"| Aggregator Ready: minimum / rata-rata (0..1) | {ready_min:.2f} / {ready_avg:.2f} |")
    L.append("")
    L.append("## Pemakaian error budget\n")
    L.append("| | Nilai |\n|---|---|")
    L.append(f"| Anggaran (event buruk yang masih diperbolehkan) | {budget:.2f} |")
    L.append(f"| Event buruk (belum terbit + terlalu lambat) | {bad:.0f} |")
    used = (bad / budget * 100) if budget > 0 else (0.0 if bad == 0 else float("inf"))
    L.append(f"| Anggaran terpakai | {'n/a (tidak ada alert kritis)' if crit == 0 else f'{used:.0f}%'} |")
    verdict = "LULUS" if (crit == 0 or (bad == 0 and p95 <= a.latency)) else "TIDAK TERPENUHI"
    L.append(f"| Penilaian SLO | **{verdict}** |")
    L.append("")
    L.append("## Pendukung\n")
    L.append(f"- Penolakan client (load shedding): Lapangan(high)={shed.get('high', 0):.0f}, Media(low)={shed.get('low', 0):.0f}")
    L.append(f"- Permintaan ke sensor: {json.dumps({k: round(v) for k, v in req.items()})}; dicegah breaker: {skipped:.0f}")
    L.append(f"- Transisi breaker: {json.dumps({k: round(v) for k, v in trans.items()})}")
    L.append(f"- Observasi disisihkan per alasan: {json.dumps({k: round(v) for k, v in rej.items()}, ensure_ascii=False)}")
    text = "\n".join(L) + "\n"
    print(text)
    if a.out:
        open(a.out, "w", encoding="utf-8").write(text)
    sys.exit(0 if verdict == "LULUS" else 1)


if __name__ == "__main__":
    main()
