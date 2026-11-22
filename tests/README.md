# Skrip uji Problem 2 dan Problem 5

Seluruh skrip di sini **tidak men-deploy aplikasi**. Mereka mengukur, mengganggu secara terkendali (dan memulihkan
sendiri), lalu mencetak LULUS/GAGAL per kriteria. Bukti (JSON, log, CSV) disimpan di `tests/results/<waktu>/`
(folder ini diabaikan Git; salin yang dibutuhkan ke laporan).

## Prasyarat
- Jalankan dari **node-c** (atau mesin lain yang `kubectl`-nya menunjuk ke klaster k3s): `kubectl`, `python3`, `bash`.
  Dari Windows gunakan Git Bash dengan `KUBECONFIG` yang benar. Di node-c jangan men-set `KUBECONFIG`.
- Klaster sudah ter-deploy dan sehat (`kubectl get nodes`, semua pod Ready, 3 shard "healthy").
- Hanya k6 yang butuh image tambahan (`grafana/k6:0.54.0`), dijalankan sebagai **Job di dalam klaster** (alat uji di luar
  pod komponen aplikasi, sesuai Lampiran B). Tidak perlu memasang k6 di node.
- `AUDIT_TOKEN` (dari asisten) perlu terisi untuk pemeriksaan lewat Audit API; tanpa itu pemeriksaan tersebut dilewati
  dan yang tersisa adalah pemeriksaan langsung ke database shard.

Jalankan dengan `bash tests/p2/03-failover.sh` (tidak perlu `chmod +x`). Variabel lingkungan mengatur parameter;
lihat komentar di kepala tiap skrip.

## Peta kriteria, skrip, dan bukti

### Problem 2: Dua Nakhoda, Satu Kapal
| Kriteria | Skrip | Yang dibuktikan | Gangguan pada klaster |
|---|---|---|---|
| 1. >=3 instance di node berbeda, titik masuk berhenti mengarahkan ke instance tidak sehat | `p2/01-entrypoint.sh` | sebaran pod, Endpoints = pod Ready, waktu instance sakit dikeluarkan, klien tetap berhasil | membekukan satu proses aggregator sementara (SIGSTOP lalu SIGCONT) |
| 2. Tiap sumber diambil tepat sekali, tanpa duplikat, upstream tidak menerima permintaan berlipat | `p2/02-exactly-once.sh` | duplikat di semua shard, duplikat lewat Audit API, satu holder per sumber per detik dan laju permintaan dari log mock | tidak ada (hanya membaca) |
| 3. Leader mati, pengganti <= 60 s, tanpa celah/duplikat | `p2/03-failover.sh` | waktu pengambilalihan, epoch naik, kursor tidak mundur, tanpa duplikat | membunuh pod leader (force) |
| 4. Jam node bergeser (+45 s lalu -30 s): tidak pernah dua penyimpan | `p2/04-clock-skew.sh` | epoch monoton, fence <= epoch lease, tidak ada dua holder, tanpa duplikat | menggeser jam satu node worker (NTP dimatikan, dipulihkan) |
| 5. Node bertugas membeku lalu bangun: tidak menyimpan apa pun | `p2/05-freeze.sh` | pengganti terpilih saat beku, instance bangun tidak menjadi leader, fence menolak epoch lama | membekukan lalu melanjutkan proses leader |
| 6. Beban >=10.000 VU, >=120 s, scaling 3->5->2, error <1% | `p2/06-load-scaling.sh` | error rate, VU tercapai, kriteria 2 tetap benar setelah scaling | k6 Job + scaling replika (dipulihkan ke 3) |
| 7. Throughput 3 instance >= 2,0x 1 instance | `p2/07-throughput.sh` | rps 1 vs 3 replika dan rasionya | scaling replika |
| 8. Ganti versi saat beban tanpa permintaan gagal | `p2/08-rolling-update.sh` | 0 permintaan gagal selama rolling update | rolling restart / ganti image |

Tes unit/integrasi P2 yang **sudah ada** (jam database, fencing, leader beku) ada di `aggregator/test/`
(`coordination.test.js`, `multi-instance.test.js`, `server-lifecycle.test.js`): `cd aggregator && npm test`.

### Problem 5: Pelampung yang Berbohong
| Kriteria | Skrip | Yang dibuktikan | Gangguan pada klaster |
|---|---|---|---|
| Laporan bagian 3 (penyimpangan sensor) | `p5/01-sensor-probe.sh` | katalog penyimpangan: kontrak, tipe, rentang, urutan, duplikat, data basi, latensi, burst, kegagalan HTTP | tidak ada (hanya GET ke sensor) |
| 1. 0 kritis hilang, p95 <= 5 s | `p5/02-critical-e2e.sh` | kritis di sensor vs tersimpan vs dikarantina vs diterima penerima; latensi; outbox kosong. `FAULT=broker` atau `FAULT=leader` menguji ketahanan | opsional: mematikan RabbitMQ / membunuh leader |
| 2. Data melanggar kontrak disisihkan | `p5/05-quarantine.sh` | 0 HazardEvent sensor melanggar kontrak; pesan disisihkan punya alasan, waktu, isi utuh | tidak ada |
| 3 dan 4. Sensor sakit: permintaan tidak melonjak, client dijawab cepat, sumber lain terjaga, pulih sendiri | `p5/03-breaker.sh` (`SCENARIO=down` atau `hang`) | permintaan ke sensor <= batas, breaker open, p95 COASTAL dan sumber lain, status sensor terlihat, waktu pulih | sensor 0 replika, atau NetworkPolicy dihapus sementara |
| 5. Overload: Lapangan dilayani, Media ditolak terkendali | `p5/04-shed.sh` | 429 hanya untuk Media (dengan Retry-After), Lapangan 0 penolakan | menurunkan anggaran konkurensi client-service sementara |
| 6, 7, 8. Kombinasi kegagalan tanpa intervensi, penjelasan dari metrik, SLO | `p5/06-gameday.sh --yes` | skenario Tester Agent (latihan) satu per satu dengan beban dan kolektor aktif; waktu pulih; kritis hilang; error budget (`slo.md`); kerangka post-mortem | skenario Tester Agent (merusak: kill pod/node, wipe, partition, clock-skew) |
| 8. Laporan SLO | `python3 p5/slo_report.py --window 1800` | pemakaian error budget dari Prometheus | tidak ada |

Tes unit P5 (tanpa klaster): `aggregator/test/pantai-unit.test.js`, `pantai-pipeline.test.js`, dan yang baru
`pantai-fuzz.test.js` (fuzz validator, batas laju breaker selama 1 jam sumber mati, pulih sendiri);
`client-service/test/shed.test.js` untuk load shedding.

## Urutan yang disarankan
1. Pemeriksaan tanpa gangguan: `p5/01-sensor-probe.sh` (kalibrasi validator dan ambang), `p2/02-exactly-once.sh`, `p5/05-quarantine.sh`.
2. P2 bertahap: `01` -> `03` -> `05` -> `04` -> `08` -> `07` -> `06`. Jalankan `02-exactly-once.sh` setelah tiap gangguan
   (skrip 03/04/05/06 sudah memanggilnya).
3. P5: `02-critical-e2e.sh` (tanpa gangguan), lalu dengan `FAULT=broker` dan `FAULT=leader`; `03-breaker.sh` untuk `down` dan `hang`;
   `04-shed.sh`.
4. Game day latihan: `06-gameday.sh --yes` lalu isi post-mortem dari `gameday-summary.md`.
5. Tunggu klaster sehat penuh di antara tes (`kubectl get pods`, `kubectl get clusters.postgresql.cnpg.io -n sistem-informasi-kebencanaan-bnpb`).

## Catatan penting
- **Kapasitas 10.000 VU.** k6 butuh sekitar 1-2 MB per VU (10-20 GB). Node saat ini hanya 3-5 GB per node, jadi 10.000 VU
  di dalam klaster tidak muat. Pilihan: (a) jalankan k6 dari mesin lain (laptop host) lewat `p2/optional-entry.yaml`
  (NodePort 30080 dan NetworkPolicy ingress, TIDAK diterapkan otomatis), atau (b) naikkan RAM VM, atau (c) turunkan `VUS` dan catat
  batasan itu di laporan. Pilihan paling jujur untuk laporan: tuliskan VU yang benar-benar tercapai dan alasannya.
- **Rate limit aggregator** (100 req/detik per IP) membuat satu pod k6 kebanyakan ditolak 429. Skrip 06/07/08 menaikkannya
  sementara (`RATE_LIMIT_PER_SEC`) dan memulihkannya di akhir; itu memicu rolling update aggregator.
- **NetworkPolicy:** client-service tidak punya aturan ingress sehingga pod k6 memerlukan policy sendiri; `k6-run.sh` membuat
  `allow-loadtest-to-*` dan menghapusnya dengan `CLEANUP=1`.
- **Skrip gangguan node** memakai pod privileged sementara berlabel `role=other` (image `alpine`, `nsenter`) dan tidak
  memerlukan SSH. Hindari menyasar node control plane (node-c) untuk pergeseran jam.
- **Skenario Tester Agent** pada game day dijalankan dalam mode latihan (`practice`). Skenario ujian terenkripsi hanya
  dijalankan asisten saat demo.
- Semua skrip memulihkan perubahan sementara (env, replika, NetworkPolicy, jam) lewat `trap EXIT`, juga saat dihentikan dengan Ctrl+C.

## Temuan saat menyiapkan tes (perlu ditindaklanjuti)
1. **Latensi notifier kosong untuk alert kritis.** `notifier_alert_latency_seconds` hanya diisi bila header `published_at_ms` ada,
   sedangkan jalur outbox (`publishConfirmed` di `aggregator/src/broker/publisher.js`) hanya mengirim `correlation_id`.
   Karena itu latensi ujung ke ujung diukur oleh `p5/collector.js`. Perbaikan yang disarankan: tambahkan
   `published_at_ms: Date.now()` pada header `publishConfirmed` (dan sebaiknya ukur dari waktu relay mengambil baris outbox).
2. **Jeda leader dengan jam mundur.** `leaderLoop` (`aggregator/src/ingest/poller.js`) dan `CircuitBreaker` memakai `Date.now()`.
   Jam yang mundur 30 detik membuat tidur siklus menjadi sekitar 33 detik (lebih panjang dari TTL 15 detik), sehingga lease lepas
   dan ada celah polling ~15-18 detik (tidak ada duplikasi atau data hilang, tetapi alert kritis tertunda). Ganti dengan jam
   monoton (`performance.now()`). `p2/04-clock-skew.sh` akan memperlihatkan perpindahan leader yang tidak perlu bila ini belum diperbaiki.
3. **Shard yang tidak terjangkau saat leader baru naik** hanya dicatat ("difence saat tulis pertama"). Tulisan leader lama ke shard
   itu bisa lolos sebelum leader baru menulis di sana. `p2/05-freeze.sh` memeriksa fence di tiap shard setelah pembekuan.
4. **client-service tanpa NetworkPolicy ingress.** Tidak ada jalur masuk selain dari pod berlabel tertentu; lihat catatan NetworkPolicy di atas.

## Struktur
```
tests/
  lib.sh                bantu bersama (kubectl, Prometheus, SQL ke ingest/shard, lease, node_sh, probe_client, pemulihan otomatis)
  probe.js              probe beban/latensi di dalam pod client-service (tanpa k6)
  p2/                   01..08 + audit_scan.js, exactly_once.py, k6-run.sh, k6/, optional-entry.yaml
  p5/                   01..06 + sensor-probe.js, collector.js, sensor_critical.js, e2e_report.py, e2e-lib.sh, slo_report.py
aggregator/test/pantai-fuzz.test.js    tes unit tambahan P5 (tanpa klaster)
```
