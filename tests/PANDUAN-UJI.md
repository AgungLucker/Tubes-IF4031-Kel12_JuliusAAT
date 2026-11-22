# Panduan uji step by step dan posisi hasilnya di laporan

Panduan ini untuk menjalankan uji P2 dan P5 dari awal sampai bukti masuk ke laporan. Skrip belum pernah dijalankan di klaster
ini, jadi kerjakan berurutan dan hentikan bila ada langkah yang gagal sebelum lanjut. Detail tiap skrip ada di
[`tests/README.md`](README.md).

Istilah posisi laporan: **BP-Kn** = bagian *Bukti Penyelesaian*, kriteria n. **Butir n** = bagian *Jawaban atas butir "Di laporan"*.
Bukti yang diminta spesifikasi: tangkapan layar, potongan log ber-correlation ID, hasil pengukuran, keluaran load testing.

---

## 0. Persiapan (sekali di awal)

Jalankan di node-c (`cd ~/Tubes-IF4031-Kel12_JuliusAAT`; jangan men-set `KUBECONFIG`).

1. Klaster sehat:
   ```bash
   kubectl get nodes                                   # semua Ready
   kubectl get pods -n sistem-informasi-kebencanaan-bnpb   # semua 1/1 Running
   kubectl get clusters.postgresql.cnpg.io -n sistem-informasi-kebencanaan-bnpb   # shard-1/2/3 "healthy", 2 instance
   ```
2. Aggregator 3 pod dan sudah membaca token sensor (restart sekali bila Secret `pantai-token` dibuat setelah pod naik):
   ```bash
   kubectl -n sistem-informasi-kebencanaan-bnpb get pods -l app=aggregator -o wide
   kubectl -n sistem-informasi-kebencanaan-bnpb exec deploy/aggregator -- sh -c 'echo ${PANTAI_AUTH_TOKEN:+terisi}'
   ```
3. `AUDIT_TOKEN` terisi (agar pemeriksaan Audit API berjalan), bila sudah dari asisten:
   ```bash
   kubectl -n sistem-informasi-kebencanaan-bnpb create secret generic aggregator-audit \
     --from-literal=AUDIT_TOKEN='<token-dari-asisten>' --dry-run=client -o yaml | kubectl apply -f -
   kubectl -n sistem-informasi-kebencanaan-bnpb rollout restart deploy/aggregator
   ```
4. Tester Agent terpasang: `kubectl get pods -n tester-agent` (satu pod per node).
5. Siapkan **tab Grafana, Prometheus, dan Jaeger** (port-forward lewat node-c) untuk tangkapan layar. Atur rentang waktu Grafana
   ke "Last 30 minutes" sebelum tiap uji.
6. Catat kondisi lingkungan untuk deklarasi topologi (jumlah node, VM atau native, host fisik, CPU dan RAM) dan tempelkan di README.
7. Folder bukti dibuat otomatis di `tests/results/<waktu>/`. Setelah tiap uji, **salin nama folder itu ke catatan Anda** supaya
   bukti mudah dicari.

**Aturan tiap langkah:** jalankan skrip, tunggu `HASIL: LULUS` atau `GAGAL`, ambil bukti yang disebut, tulis ke posisi laporan.
Bila `GAGAL`, jangan menulis "lulus" di laporan: catat angka sebenarnya dan alasannya, lalu perbaiki atau masukkan ke Batasan.
Beri jeda sampai klaster sehat penuh (langkah 0.1) di antara dua uji yang merusak.

---

## Problem 2: Dua Nakhoda, Satu Kapal

Urutan yang disarankan: 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 → 2.7 → 2.8. Uji beban (2.6–2.8) paling akhir karena mengubah replika dan env.

### 2.1 Kriteria 1: ≥3 instance di node berbeda, titik masuk berhenti mengarahkan ke instance sakit
- **Perintah:** `bash tests/p2/01-entrypoint.sh`
- **Lulus bila:** ≥3 pod Running/Ready, tersebar di node berbeda, Endpoints sama dengan pod Ready, instance yang dibekukan keluar
  dari Endpoints ≤20 detik, dan tidak ada kegagalan klien sesudahnya.
- **Ambil:** keluaran terminal (tabel pod dan node, waktu keluar dari Endpoints), `probe.json` di folder hasil.
  Tangkapan layar: `kubectl get pods -l app=aggregator -o wide`.
- **Letakkan di laporan:** **BP-K1** (P2): tabel pod → node, waktu instance sakit keluar dari Endpoints, jumlah kegagalan klien.

### 2.2 Kriteria 2: tepat sekali, tanpa duplikat, upstream tidak berlipat
- **Perintah:** `SINCE=30m bash tests/p2/02-exactly-once.sh`
- **Lulus bila:** 0 `source_ref_id` ganda di semua shard, 0 duplikat di Audit API, satu holder per sumber pada tiap detik, laju
  permintaan ≈ 1× laju satu poller.
- **Ambil:** `all_refs.txt` (jumlah baris), `audit_scan.json`, `upstream.json`. Salin **potongan log mock** yang memuat
  `X-Correlation-ID: poll:<pod>:<sumber>:e<epoch>:<n>` (potongan log ber-correlation ID yang diminta spesifikasi):
  ```bash
  kubectl -n sistem-informasi-kebencanaan-bnpb logs deploy/bmkg-mock --since=10m --timestamps | grep -o 'poll:[^"]*' | head -20
  ```
- **Letakkan:** **BP-K2** (P2): potongan log, ringkasan `upstream.json` (holder, epoch, laju), hasil duplikat 0.

### 2.3 Kriteria 3: leader mati, pengganti ≤ 60 detik, tanpa celah dan duplikat
- **Perintah:** `SOURCE=BMKG MAX_S=60 bash tests/p2/03-failover.sh` (ulangi untuk `SOURCE=PVMBG`)
- **Lulus bila:** pengambilalihan ≤60 detik, epoch naik, kursor tidak mundur, 0 duplikat.
- **Ambil:** `ringkasan.txt` (T_lead, T_data, epoch sebelum dan sesudah), keluaran terminal, tangkapan layar Grafana
  (`aggregator_is_leader` atau `aggregator_lease_epoch` berpindah pod).
- **Letakkan:** **BP-K3** (P2): waktu pengambilalihan, epoch lama → baru, bukti 0 duplikat. Waktu ini juga mengonfirmasi angka
  "15–18 detik" di **Butir 3** (P2).

### 2.4 Kriteria 4: jam bergeser +45 s lalu −30 s
- **Perintah:** `NODE=node-b SOURCE=BMKG bash tests/p2/04-clock-skew.sh`
  (jangan node-c; atau `USE_TESTER=1 bash tests/p2/04-clock-skew.sh` untuk skenario latihan Tester Agent).
- **Lulus bila:** epoch monoton, fence di semua shard ≤ epoch lease, 0 duplikat, tidak ada dua holder pada detik yang sama.
- **Ambil:** `lease_samples.csv`, keluaran terminal, `exactly_once.txt`.
- **Catatan jujur:** bila leader berpindah saat jam mundur, itu bug jam dinding yang sudah dicatat di Batasan (jeda ≈33 detik). Tulis
  apa adanya, jangan disembunyikan.
- **Letakkan:** **BP-K4** (P2): urutan epoch dari `lease_samples.csv`, hasil fence, hasil 0 duplikat.

### 2.5 Kriteria 5: node membeku lalu bangun
- **Perintah:** `SOURCE=BMKG FREEZE_S=40 bash tests/p2/05-freeze.sh`
  (untuk pembekuan sungguhan saat demo: suspend VM atau tutup laptop, lalu `SKIP_INJECT=1 bash tests/p2/05-freeze.sh`).
- **Lulus bila:** pengganti terpilih saat beku, epoch naik, instance yang bangun bukan leader (`aggregator_is_leader=0`), fence di shard ≥
  epoch baru, 0 duplikat.
- **Ambil:** `log_instance_bangun.txt` (baris `[lease]` atau `[fence]` dari pod yang bangun), keluaran terminal.
- **Letakkan:** **BP-K5** (P2): potongan log pod yang bangun, epoch lama vs baru, hasil fence.

### 2.6 Kriteria 6: ≥10.000 VU, ≥120 detik, scaling 3 → 5 → 2
- **Perintah:** `bash tests/p2/06-load-scaling.sh` (bila memori node kurang: `VUS=<angka-yang-muat>` dan catat alasannya; atau
  `K6_NODE=node-c K6_MEM_REQ=2Gi K6_MEM_LIM=6Gi`).
- **Lulus bila:** VU tercapai, error di luar 429 <1%, ambang k6 terpenuhi, kriteria 2 tetap benar sesudahnya.
- **Ambil:** `k6_summary.json`, `k6.log`, `timeline.txt` (daftar pod tiap fase scaling), tangkapan layar Grafana saat 5 → 2 replika
  (rate permintaan, error, jumlah pod).
- **Letakkan:** **BP-K6** (P2): VU maksimum tercapai, durasi, error rate, jumlah 429, bukti 0 duplikat. Bila VU kurang dari 10.000, tulis jumlah
  sebenarnya dan alasan memori (juga sudah ada di Batasan).

### 2.7 Kriteria 7: throughput 3 instance ≥ 2,0× 1 instance
- **Perintah:** `bash tests/p2/07-throughput.sh`
- **Lulus bila:** rasio ≥ 2,0.
- **Ambil:** `ringkasan.txt` (req/s 1 replika, 3 replika, rasio), `summary_1_replika.json`, `summary_3_replika.json`.
- **Letakkan:** **BP-K7** (P2): dua angka req/s dan rasio. Catat bahwa batas laju per IP dinaikkan sementara.

### 2.8 Kriteria 8: ganti versi saat beban tanpa permintaan gagal
- **Perintah:** `bash tests/p2/08-rolling-update.sh` (atau `NEW_TAG=<tag> bash tests/p2/08-rolling-update.sh` untuk versi berbeda).
- **Lulus bila:** `real_errors = 0`, rollout selesai dengan 3 pod Ready.
- **Ambil:** `k6_summary.json`, keluaran terminal (rollout status).
- **Letakkan:** **BP-K8** (P2): jumlah permintaan gagal (0) dan image sebelum dan sesudah.

### 2.9 Penutup P2
- Tuliskan konfigurasi load test nyata (VU yang benar-benar dipakai) di **Butir 4** (P2) bila berbeda dari rencana.
- Spesifikasi lingkungan uji ke deklarasi topologi di README.

---

## Problem 5: Pelampung yang Berbohong

Urutan: 5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 5.7 (game day paling akhir). Sensor berjalan pada profil latihan (`practice`).

### 5.1 Katalog penyimpangan sensor (bahan **Butir 3**)
- **Perintah:** `DURATION_S=300 bash tests/p5/01-sensor-probe.sh`
- **Ambil:** ringkasan di terminal (daftar penyimpangan dengan jumlah dan contoh), `sensor-probe.json`.
- **Gunakan untuk:** (a) mengkalibrasi ambang (`PANTAI_MAX_SEA_LEVEL_M`, `PANTAI_MAX_WAVE_M`, `PANTAI_MAX_LAG_S`, `PANTAI_QUALITY_OK`); bila
  ada yang diubah, ubah juga di manifest dan **Butir 2** (P5, konfigurasi); (b) mengisi tabel penyimpangan.
- **Letakkan:** **Butir 3** (P5): satu baris per penyimpangan nyata, yaitu *apa yang ditemukan* (id dan contoh), *cara menemukan* (probe dan
  kolom yang dibandingkan), *cara menangani* (validator, breaker, deteksi basi, outbox). Jangan memasukkan penyimpangan yang tidak muncul di probe.

### 5.2 Data melanggar kontrak disisihkan (kriteria 2)
- **Perintah:** `bash tests/p5/05-quarantine.sh` (jalankan setelah 5.1, supaya ada data rusak yang sudah diproses)
- **Lulus bila:** 0 HazardEvent sensor melanggar kontrak; pesan yang disisihkan punya alasan, waktu, isi utuh.
- **Ambil:** tabel jumlah per kelas alasan (`contract_violation`, `out_of_range`, `quality_not_ok`, `unknown_station`) dan contoh alasan; tangkapan
  layar panel Grafana "Ditolak per alasan".
- **Catatan:** bila sensor profil latihan tidak mengirim data rusak, tes ini lulus tanpa menguji apa-apa. Tulis itu, dan rujuk tes unit
  `pantai-pipeline.test.js` dan `pantai-fuzz.test.js` sebagai bukti kasus rusak.
- **Letakkan:** **BP-K2** (P5).

### 5.3 Alert kritis tidak hilang, p95 ≤ 5 detik (kriteria 1)
- **Perintah (tiga kali):**
  1. `SECS=180 bash tests/p5/02-critical-e2e.sh` (tanpa gangguan)
  2. `FAULT=broker FAULT_S=30 SECS=240 bash tests/p5/02-critical-e2e.sh` (RabbitMQ mati di tengah uji)
  3. `FAULT=leader SECS=240 bash tests/p5/02-critical-e2e.sh` (leader sensor dibunuh)
- **Lulus bila:** `hilang=0`, `tak_sampai=0`, outbox kosong, p95 ≤ 5 detik.
- **Ambil:** `e2e.txt` dan `e2e.json` dari ketiga uji; tangkapan layar Grafana "Alert tertua belum terkirim", "Alert kritis menunggu di outbox",
  dan "Latensi alert kritis".
- **Catatan:** bila "event_AWAS_selama_jendela" = 0, tidak ada alert kritis yang diuji; perpanjang `SECS` atau ulangi saat sensor menghasilkan
  kritis. Latensi diukur dari `ingested_at` ke penerima (lihat Batasan).
- **Letakkan:** **BP-K1** (P5): kritis di sensor / tersimpan / dikarantina / diterima, `hilang`, p50/p95/p99. Hasil dengan gangguan
  menjadi bukti ketahanan di kalimat yang sama.

### 5.4 Sensor bermasalah: permintaan tidak melonjak, client cepat, sumber lain terjaga, pulih sendiri (kriteria 3 dan 4)
- **Perintah (dua kali):**
  1. `SCENARIO=down DUR=120 bash tests/p5/03-breaker.sh`
  2. `SCENARIO=hang DUR=120 bash tests/p5/03-breaker.sh`
- **Lulus bila:** permintaan ke sensor ≤ batas, breaker open, p95 `COASTAL` dan sumber lain di bawah batas, respons menandai
  `source_status`, pemulihan otomatis.
- **Ambil:** `ringkasan.txt`, `probe_coastal.json`, `probe_other.json`; tangkapan layar Grafana "Circuit breaker sensor" (CLOSED → OPEN →
  CLOSED), "Permintaan ke sensor per hasil", "Transisi breaker".
- **Catatan:** batas 300 ms pada tes ini diterapkan ke campuran SEISMIC dan VOLCANIC, tidak persis kondisi M1 (BMKG-only, delay PVMBG 3 detik,
  ≥50 koneksi). Tulis perbedaan itu bila ingin klaim "memenuhi kriteria latensi M1".
- **Letakkan:** **BP-K3** (hasil p95 sumber lain) dan **BP-K4** (permintaan ke sensor, p95 `COASTAL`, `source_status`, waktu pulih).

### 5.5 Overload: Lapangan dilayani, Media ditolak terkendali (kriteria 5)
- **Perintah:** `bash tests/p5/04-shed.sh` (anggaran diturunkan sementara; `NO_TUNE=1` untuk anggaran asli bila beban cukup)
- **Lulus bila:** Media 429 > 0 dengan `Retry-After`, Lapangan 0 penolakan dan 0 error, p95 Lapangan di bawah batas.
- **Ambil:** keluaran terminal (baris Media dan Lapangan), tangkapan layar Grafana "Media ditolak", "Tim Lapangan ditolak", "Penolakan per prioritas".
- **Catatan:** tulis bahwa anggaran konkurensi diturunkan selama uji, jadi yang dibuktikan adalah logika prioritas, bukan kapasitas asli.
- **Letakkan:** **BP-K5** (P5).

### 5.6 Kegagalan dapat dijelaskan dari dashboard, metrik, dan jejak (kriteria 7)
Tidak ada skrip; ini bukti manual dan harus diambil **saat uji 5.3–5.5 atau game day berjalan**.
1. Tangkapan layar dashboard `aggregator` dan `client-service` pada saat gangguan (satu per fase: normal, gangguan, pulih).
2. **Satu jejak** di Jaeger untuk satu permintaan `/data` yang melewati client-service, token-service, dan aggregator, dengan durasi tiap langkah.
3. **Potongan log terstruktur** dengan correlation ID yang sama di tiga service:
   ```bash
   kubectl -n sistem-informasi-kebencanaan-bnpb logs deploy/client-service --since=5m | grep <correlation-id>
   kubectl -n sistem-informasi-kebencanaan-bnpb logs deploy/aggregator    --since=5m | grep <correlation-id>
   ```
- **Letakkan:** **BP-K7** (P5). Pastikan setiap anggota kelompok bisa menunjuk panel yang mendeteksi tiap gangguan.

### 5.7 Game day latihan: kombinasi kegagalan, tanpa intervensi, SLO (kriteria 6 dan 8, Butir 4)
- **Perintah:** `bash tests/p5/06-gameday.sh --yes`
  (atau `SCENARIOS="kill-leader partition" RECOVERY_S=180 bash tests/p5/06-gameday.sh --yes`).
  **Merusak** (kill pod dan node, wipe data, partisi, geser jam). Pastikan klaster sehat dan semua uji lain sudah selesai.
- **Selama berjalan:** jangan melakukan intervensi apa pun. Ambil tangkapan layar Grafana tiap fase.
- **Ambil:** `gameday-summary.md`, `timeline.csv` (waktu pulih tiap skenario), `e2e.txt`, `slo.md`, `probe_ringkasan.txt`, `state_*.txt`.
- **Letakkan:**
  - **BP-K6** (P5): tabel skenario, waktu pulih tanpa intervensi, hasil `e2e` (kritis hilang).
  - **Paragraf target keandalan** (P5): angka dari `slo.md` (alert kritis, buruk, anggaran, anggaran terpakai).
  - **Butir 4** (P5, post-mortem): tulis empat aspek dari `gameday-summary.md` dan tangkapan layar:
    **deteksi** (panel atau metrik pertama yang menunjukkan gangguan dan berapa detik setelah gangguan), **dampak** (kritis hilang, latensi,
    penolakan, kegagalan client), **mitigasi** (mekanisme yang bekerja otomatis dan lama pulih), **perbaikan** (apa yang diubah setelah temuan).
  - **Batasan** (P5): tambahkan temuan baru yang muncul selama game day.

---

## Ringkasan posisi hasil di laporan

| Hasil | P2 | P5 |
|---|---|---|
| Tabel pod, node, waktu instance sakit keluar | BP-K1 | |
| Potongan log `X-Correlation-ID` upstream, 0 duplikat | BP-K2 | |
| Waktu pengambilalihan, epoch | BP-K3 (dan angka di Butir 3) | |
| Urutan epoch, fence, geser jam | BP-K4 | |
| Log instance yang bangun, fence | BP-K5 | |
| VU tercapai, error rate, scaling | BP-K6 | |
| Rasio throughput | BP-K7 | |
| Permintaan gagal saat rolling update | BP-K8 | |
| Kritis hilang, latensi alert | | BP-K1 |
| Karantina dan alasan | | BP-K2 |
| p95 sumber lain, permintaan ke sensor, `source_status`, waktu pulih | | BP-K3 dan BP-K4 |
| Shedding Media vs Lapangan | | BP-K5 |
| Waktu pulih game day | | BP-K6 |
| Dashboard, trace, log berkorelasi | | BP-K7 |
| Error budget | | Paragraf target keandalan |
| Katalog penyimpangan sensor | | Butir 3 |
| Post-mortem | | Butir 4 |
| Spesifikasi node dan host | README (deklarasi topologi) | README |

## Checklist akhir
- [ ] Setiap baris **[ISI]** di `Laporan-M2-P2.md` dan `Laporan-M2-P5.md` sudah diganti angka nyata, atau dihapus beserta alasannya.
- [ ] Uji yang `GAGAL` ditulis apa adanya (angka sebenarnya dan penyebabnya), bukan dihilangkan.
- [ ] Deklarasi topologi, diagram deployment, perubahan dari M1, dan form penggunaan AI (Bagian Umum spesifikasi) sudah ada di laporan akhir.
- [ ] Laporan akhir diekspor ke PDF dengan nama `IF4031_M2_<NamaKelompok>.pdf`.
- [ ] Klaster dikembalikan sehat dan semua perubahan sementara (replika 3, `RATE_LIMIT_PER_SEC`, NetworkPolicy k6) sudah dipulihkan:
  `kubectl get deploy aggregator client-service sensor-pantai -n sistem-informasi-kebencanaan-bnpb`, `kubectl get networkpolicy -n sistem-informasi-kebencanaan-bnpb`.
