# M2 Tugas Besar IF4031 Arsitektur Aplikasi Terdistribusi: Kelompok 12 JuliusAAT

Platform koordinasi kebencanaan BNPB yang menggabungkan BMKG, PVMBG, Feed Satelit, dan Sensor Pantai. Seluruh komponen berjalan di
Kubernetes (k3s) pada namespace `sistem-informasi-kebencanaan-bnpb`: Aggregator (3 instance), shard HazardEvent (PostgreSQL via
CloudNativePG), Client Service, Token Service, RabbitMQ, consumer (dashboard dan notifier), mock BMKG dan PVMBG, satellite processor,
Sensor Pantai, serta Prometheus, Grafana, dan Jaeger.

## 1. Deklarasi topologi

| Node | Peran | Jenis | Host fisik | OS | vCPU | RAM | Disk |
|---|---|---|---|---|---|---|---|
| `node-c` | control plane dan worker | VM Ubuntu | Laptop A (Windows): **[ISI model, CPU, RAM host]** | Ubuntu 26.04 | 4 | 5,3 GB | 38 GB |
| `node-b` | worker | VM VirtualBox | Laptop B: **[ISI model, OS, CPU, RAM host]** | Ubuntu 26.04 | 2 | 4 GB | 40 GB |
| `node-d` | worker | VM VirtualBox | Laptop B (sama dengan `node-b`) | Ubuntu 26.04 | 2 | 4 GB | 40 GB |

Jumlah node: 3, masing-masing dengan kernel terpisah (VM). Seluruh trafik antar node melewati jaringan Tailscale (`tailscale0`),
sehingga alamat node adalah IP Tailscale. Perhatian: ukuran VM di atas harus disesuaikan dengan kondisi sebenarnya saat demo.

## 2. Prasyarat

- 3 mesin Linux (VM atau native) dengan Ubuntu, akses `sudo`, dan Tailscale terpasang serta bergabung ke tailnet yang sama.
- `kubectl`, `bash`, `openssl`, `git` di node-c.
- Akses internet ke GHCR dan Docker Hub (image dan manifest ditarik dari sana).

## 3. Langkah menjalankan dari kondisi awal

**3.1 Siapkan setiap node** (node-c, node-b, node-d)
```bash
# Matikan AppArmor (di Ubuntu 26.04 AppArmor menolak sinyal proses PostgreSQL sehingga shard crash-loop)
sudo sed -i 's/^GRUB_CMDLINE_LINUX_DEFAULT=.*/GRUB_CMDLINE_LINUX_DEFAULT=" apparmor=0"/' /etc/default/grub
sudo update-grub && sudo reboot
# Pastikan Tailscale aktif dan catat IP-nya
tailscale ip -4
```

**3.2 Pasang k3s di node-c (control plane)**
```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_EXEC="server --node-name node-c --node-ip <IP_TAILSCALE_C> \
  --advertise-address <IP_TAILSCALE_C> --tls-san <IP_TAILSCALE_C> --flannel-iface tailscale0" sh -
sudo cat /var/lib/rancher/k3s/server/node-token       # simpan, jangan dibagikan
```

**3.3 Gabungkan worker** (di `node-b` dan `node-d`, ganti nama dan IP masing-masing)
```bash
curl -sfL https://get.k3s.io | K3S_URL=https://<IP_TAILSCALE_C>:6443 K3S_TOKEN=<TOKEN> \
  INSTALL_K3S_EXEC="agent --node-name node-b --node-ip <IP_TAILSCALE_B> --flannel-iface tailscale0" sh -
kubectl get nodes        # di node-c: ketiga node Ready
```

**3.4 Ambil kode dan deploy dengan satu perintah** (di node-c)
```bash
git clone https://github.com/AgungLucker/Tubes-IF4031-Kel12_JuliusAAT && cd Tubes-IF4031-Kel12_JuliusAAT
AUDIT_TOKEN='<token-audit-dari-asisten>' ./scripts/deploy.sh
```
`scripts/deploy.sh` memeriksa klaster, membuat Secret (kunci JWT, token Sensor Pantai, token audit), memasang operator CloudNativePG dan tiga
shard, menerapkan seluruh manifest (`kubectl apply -k k8s/`), memasang Tester Agent, menunggu semua rollout, lalu memeriksa kontrak
platform (label `role`, jumlah pod `store`, sebaran aggregator). Skrip idempoten dan aman dijalankan ulang. Opsi (variabel lingkungan):
`SKIP_SHARDS=1`, `SKIP_TESTER_AGENT=1`, `PANTAI_AUTH_TOKEN`, `GHCR_USERNAME` dan `GHCR_TOKEN` (bila image privat).

**3.5 Verifikasi**
```bash
NS=sistem-informasi-kebencanaan-bnpb
kubectl get pods -n $NS -o wide                              # semua Running dan Ready
kubectl get clusters.postgresql.cnpg.io -n $NS               # shard-1/2/3: "Cluster in healthy state"
kubectl get pods -n $NS -l app=aggregator -o wide            # 3 instance
kubectl get pods -n tester-agent                             # satu pod per node
```

**3.6 Bila kode berubah** (di mesin dengan Docker): build dan push image ke GHCR, ganti tag, lalu jalankan ulang deploy.
```bash
docker build -t ghcr.io/julius123123/bnpb-aggregator:<tag> ./aggregator && docker push ghcr.io/julius123123/bnpb-aggregator:<tag>
./scripts/set-image-tags.ps1 -Tag <tag> -Images bnpb-aggregator        # mengubah newTag di k8s/kustomization.yaml
```

**3.7 Akses observabilitas** (dari PC; tiga terminal terpisah; buka `http://localhost:3000` untuk Grafana dan `:16686` untuk Jaeger)
```bash
ssh -L 3000:127.0.0.1:3000   <user>@<IP_TAILSCALE_C> "kubectl port-forward -n sistem-informasi-kebencanaan-bnpb --address 127.0.0.1 svc/grafana 3000:3000"
ssh -L 16686:127.0.0.1:16686 <user>@<IP_TAILSCALE_C> "kubectl port-forward -n sistem-informasi-kebencanaan-bnpb --address 127.0.0.1 svc/jaeger 16686:16686"
ssh -L 9090:127.0.0.1:9090   <user>@<IP_TAILSCALE_C> "kubectl port-forward -n sistem-informasi-kebencanaan-bnpb --address 127.0.0.1 svc/prometheus 9090:9090"
```

**Pengembangan lokal** (tanpa Kubernetes): salin `.env.example` menjadi `.env`, isi nilainya, lalu `docker compose up --build -d`.

## 4. Variabel konfigurasi

Daftar lengkap dan contoh nilai ada di [`.env.example`](.env.example). Di Kubernetes, kredensial disimpan sebagai **Secret** dan konfigurasi
sebagai **ConfigMap** (`k8s/config/`). Yang paling relevan untuk Problem 2 dan 5:

| Variabel | Bawaan | Fungsi |
|---|---|---|
| `LEASE_TTL_SECONDS` | `15` | masa berlaku lease pemimpin per sumber (Problem 2) |
| `POLL_INTERVAL_MS` | `3000` | interval polling sumber dan perpanjangan lease |
| `RATE_LIMIT_PER_SEC` | `100` | batas permintaan per IP pada aggregator |
| `PANTAI_AUTH_TOKEN` | Secret `pantai-token` | token Sensor Pantai |
| `PANTAI_POLL_MS` / `PANTAI_TIMEOUT_MS` | `1000` / `1500` | polling dan batas waktu permintaan ke sensor |
| `BREAKER_FAILURES` / `BREAKER_OPEN_MS` / `BREAKER_MAX_OPEN_MS` | `3` / `5000` / `60000` | circuit breaker ke sensor |
| `PANTAI_MAX_LAG_S` | `900` | batas data sensor dianggap basi (waktu sensor) |
| `PANTAI_MAX_SEA_LEVEL_M` / `PANTAI_MAX_WAVE_M` / `PANTAI_QUALITY_OK` | `30` / `60` / `ok` | batas kewajaran validator kontrak |
| `OUTBOX_POLL_MS` | `500` | siklus relai alert kritis ke RabbitMQ |
| `CLIENT_MAX_INFLIGHT` / `CLIENT_MEDIA_SHARE` | `200` / `0.6` | anggaran konkurensi dan jatah Media (load shedding) |
| `AUDIT_TOKEN` | Secret `aggregator-audit` | token Audit API (diberikan asisten) |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_SECONDS` | `60` / `600` | masa berlaku token klien |

## 5. Cara memicu skenario pengujian

Uji dijalankan dari node-c. Panduan langkah demi langkah beserta bukti yang harus diambil ada di
[`tests/PANDUAN-UJI.md`](tests/PANDUAN-UJI.md), dan penjelasan tiap skrip di [`tests/README.md`](tests/README.md). Skrip tidak men-deploy aplikasi.

**Problem 2: Dua Nakhoda, Satu Kapal**

| Kriteria | Perintah |
|---|---|
| 1. instance tersebar, titik masuk | `bash tests/p2/01-entrypoint.sh` |
| 2. tepat sekali | `bash tests/p2/02-exactly-once.sh` |
| 3. leader mati, pengganti ≤ 60 s | `SOURCE=BMKG bash tests/p2/03-failover.sh` |
| 4. jam bergeser | `NODE=node-b bash tests/p2/04-clock-skew.sh` |
| 5. node membeku lalu bangun | `SOURCE=BMKG bash tests/p2/05-freeze.sh` |
| 6. beban ≥ 10.000 VU, scaling 3 → 5 → 2 | `bash tests/p2/06-load-scaling.sh` |
| 7. throughput 3 instance ≥ 2× | `bash tests/p2/07-throughput.sh` |
| 8. ganti versi saat beban | `bash tests/p2/08-rolling-update.sh` |

**Problem 5: Pelampung yang Berbohong**

| Kriteria | Perintah |
|---|---|
| penyimpangan sensor (laporan butir 3) | `bash tests/p5/01-sensor-probe.sh` |
| 1. alert kritis tidak hilang, p95 ≤ 5 s | `FAULT=broker bash tests/p5/02-critical-e2e.sh` |
| 2. data rusak disisihkan | `bash tests/p5/05-quarantine.sh` |
| 3 dan 4. sensor sakit: tidak melonjak, client cepat, pulih sendiri | `SCENARIO=down bash tests/p5/03-breaker.sh` (juga `hang`) |
| 5. Lapangan dilayani, Media ditolak | `bash tests/p5/04-shed.sh` |
| 6 dan 8. kombinasi kegagalan, SLO | `bash tests/p5/06-gameday.sh --yes` (merusak; skenario latihan Tester Agent) |

Skenario Tester Agent (latihan) juga dapat dipicu langsung:
```bash
kubectl exec -n tester-agent daemonset/tester-agent -- /app list
kubectl exec -n tester-agent daemonset/tester-agent -- /app run practice <nama>
```

**Problem 1, 3, dan 4:** **[ISI oleh anggota yang mengerjakan: perintah pemicu dan skenario pengujian]**.

## 6. Struktur repositori

```
k8s/        manifest (kustomize), shard CNPG, NetworkPolicy, monitoring    scripts/   deploy.sh, set-image-tags.ps1
tests/      skrip uji P2 dan P5, panduan uji                               aggregator/ client-service/ bnpb-token/ ...   kode komponen
```

## 7. Kelompok 12 - JuliusAAT

| NIM | Nama | Pembagian Tugas |
| :---: | :---: | :--- |
| 13523023 | Muhammad Aufa Farabi | *Implementasi Aggregator Service dari BNPB, dan canonical store, Laporan* |
| 13523030 | Julius Arthur | *Implementasi BNPB Token Service, Client Service, serta publisher dan consumer, Laporan* |
| 13523051 | Ferdinand Gabe Tua Sinaga | *Implementasi mock BMKG dan PVMBG, serta store terkait untuk masing-masing service , Laporan* |
