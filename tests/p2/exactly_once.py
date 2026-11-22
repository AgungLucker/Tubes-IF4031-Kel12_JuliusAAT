#!/usr/bin/env python3
"""Bukti kriteria P2 nomor 2 dari sisi UPSTREAM: setiap sumber hanya di-poll oleh satu instance pada satu waktu.

Aggregator menandai tiap permintaan ke sumber dengan X-Correlation-ID  poll:<holder>:<SUMBER>:e<epoch>:<urutan>.
Skrip ini membaca log mock BMKG/PVMBG (kubectl logs --timestamps), lalu memeriksa:
  1. pada setiap jendela 1 detik hanya ada satu holder per sumber (dua holder = pelanggaran atau perlu dikaji);
  2. laju permintaan per sumber tidak berlipat (<= RASIO_MAKS x laju yang diharapkan untuk satu poller);
  3. ringkasan perpindahan leader (holder, epoch) sepanjang jendela pengamatan.

Pemakaian:  python3 exactly_once.py [--since 30m] [--ns NAMESPACE] [--interval 3] [--out berkas.json]
Kode keluar 0 = lulus, 1 = ada pelanggaran.
"""
import argparse, collections, json, re, subprocess, sys

POLL_RE = re.compile(r"poll:(?P<holder>[^:\s\"]+):(?P<src>[A-Z_]+):e(?P<epoch>\d+):(?P<seq>\d+)")
TS_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?Z")
# jumlah permintaan upstream per siklus poll satu sumber (BMKG memanggil dua endpoint)
CALLS_PER_CYCLE = {"BMKG": 2, "PVMBG": 1}
MOCKS = {"BMKG": "bmkg-mock", "PVMBG": "pvmbg-mock"}


def logs(ns, deploy, since):
    r = subprocess.run(["kubectl", "-n", ns, "logs", f"deploy/{deploy}", "--since=" + since, "--timestamps"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"peringatan: gagal membaca log {deploy}: {r.stderr.strip()[:120]}", file=sys.stderr)
    return r.stdout.splitlines()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ns", default="sistem-informasi-kebencanaan-bnpb")
    ap.add_argument("--since", default="30m")
    ap.add_argument("--interval", type=float, default=3.0, help="interval poll (detik)")
    ap.add_argument("--ratio-max", type=float, default=1.5)
    ap.add_argument("--out")
    a = ap.parse_args()

    report, violations = {}, 0
    for src, mock in MOCKS.items():
        reqs = []  # (detik, holder, epoch)
        for line in logs(a.ns, mock, a.since):
            ts, m = TS_RE.match(line), POLL_RE.search(line)
            if not (ts and m) or m["src"] != src:
                continue
            reqs.append((ts.group(1), m["holder"], int(m["epoch"])))
        if not reqs:
            report[src] = {"requests": 0, "catatan": "tidak ada permintaan bertanda poll: di log mock (periksa X-Correlation-ID / --since)"}
            continue

        per_second = collections.defaultdict(set)
        for sec, holder, _ in reqs:
            per_second[sec].add(holder)
        overlaps = {s: sorted(h) for s, h in per_second.items() if len(h) > 1}

        order = sorted(set((s for s, _, _ in reqs)))
        span = max(1.0, _to_s(order[-1]) - _to_s(order[0]))
        expected = (span / a.interval) * CALLS_PER_CYCLE[src]
        ratio = len(reqs) / expected if expected else 0.0

        leaders, last = [], None
        for sec, holder, epoch in sorted(reqs):
            if (holder, epoch) != last:
                leaders.append({"mulai": sec, "holder": holder, "epoch": epoch})
                last = (holder, epoch)

        sv = []
        if overlaps:
            sv.append(f"{len(overlaps)} detik dengan >1 holder (mis. {next(iter(overlaps.items()))})")
        if ratio > a.ratio_max:
            sv.append(f"laju permintaan {ratio:.2f}x laju satu poller (batas {a.ratio_max}x)")
        violations += len(sv)
        report[src] = {
            "requests": len(reqs), "jendela_detik": round(span), "laju_relatif_thd_satu_poller": round(ratio, 2),
            "holder_berbeda": len({h for _, h, _ in reqs}), "perpindahan_leader": leaders,
            "detik_dengan_lebih_dari_satu_holder": len(overlaps), "pelanggaran": sv,
        }

    print(json.dumps(report, indent=2, ensure_ascii=False))
    if a.out:
        open(a.out, "w", encoding="utf-8").write(json.dumps(report, indent=2, ensure_ascii=False))
    sys.exit(1 if violations else 0)


def _to_s(iso):
    import datetime as dt
    return dt.datetime.strptime(iso, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=dt.timezone.utc).timestamp()


if __name__ == "__main__":
    main()
