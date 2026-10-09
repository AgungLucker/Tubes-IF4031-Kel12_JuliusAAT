# M1 Tugas Besar IF4031 Arsitektur Aplikasi Terdistribusi - Kelompok 12 JuliusAAT 


Tugas Besar ini mengimplementasikan platform koordinasi kebencanaan yang menjembatani BMKG, PVMBG, dan BNPB, dengan BNPB berperan sebagai node koordinasi. Sistem dibangun dari beberapa service independen yang berkomunikasi lewat HTTP/REST dan message broker, mencakup polling data dari dua instansi sumber, pemetaan data ke format kanonik `HazardEvent` yang tetap berjalan tanpa redeploy saat skema sumber bertambah field baru, penanganan concurrency dan graceful degradation saat salah satu sumber tidak tersedia, autentikasi dengan domain kepercayaan terpisah untuk tiap instansi sumber dan client downstream, penyimpanan HazardEvent pada storage yang memungkinkan field baru tanpa migrasi skema, serta distribusi event secara pub/sub lewat message broker.


## Komponen Sistem

**Instansi Sumber Data**
- **BMKG Mock Service**, sumber data untuk event gempa dan potensi tsunami (SeismicEvent TsunamiWarning), dengan response time rendah dan konsisten (delay tetap 50–150 ms). `GET /seismic-events`, `GET /tsunami-warnings`, `GET /health`.
- **PVMBG Mock Service**, sumber data untuk event gunung api (VolcanicReport), dengan response time lebih tinggi dan fluktuatif (delay acak 500 ms–3 detik yang dapat dikonfigurasi) untuk mensimulasikan infrastruktur lawas, serta mendukung outage instan dan perubahan skema saat runtime. `GET /volcanic-reports`, `GET /health`, `POST /admin/schema-version`, `POST /admin/outage`.

**Komponen BNPB**
- **Gateway / Aggregator**, Melakukan polling berkala ke BMKG dan PVMBG, memetakan data ke format kanonik HazardEvent kemudian menyimpannya ke Canonical Store, menyediakan endpoint bagi Client Service untuk pengambilan data HazardEvent, dan mempublikasikan event ke message broker.
- **Canonical Store**, tempat penyimpanan `HazardEvent`, hanya dapat diakses langsung oleh Aggregator. Pada Canonical store, untuk menyimpan atribut dinamis digunakan atribut dengan kolom bertipe JSONB dari PostgreSQL sehingga field baru dari sumber data dapat langsung tertampung tanpa migrasi skema pada database.
- **Client Service (Client-Facing API)**, gateway bagi client downstream (Media/Pers, Tim Lapangan, BNPB Pusat) untuk mengakses data lewat Aggregator, dengan pembatasan field sesuai scope masing-masing.
- **BNPB Token Service (Auth Token Service)**, men-generate dan memperbarui (refresh) access token (JWT) serta refresh token untuk client downstream, dan menyediakan endpoint introspeksi sesi.
- **Message Broker**, menyalurkan `HazardEvent` dari Aggregator ke multi consumer tanpa producer mengetahui siapa consumer-nya.
- **Consumer**, services yang subscribe `HazardEvent` dari broker, terdiri dari dashboard updater dan notifier.

## Tech Stack
- **Backend**: Node.js, Express (express-rate-limit for rate limiter)
- **Database**: PostgreSQL 
- **Message Broker**: RabbitMQ
- **Autentikasi**: JWT (ES256), library `jose`
- **Infrastructure**: Docker & Docker Compose
- **Load Testing**: k6

## Persyaratan Awal

- [Docker](https://www.docker.com/) dan Docker Compose v2 (`docker compose`)
- [k6](https://k6.io/) untuk menjalankan load testing di Problem 2

## Cara Menjalankan

1. Clone repository dan pindah ke direktori utama proyek:
   ```bash
   git clone https://github.com/AgungLucker/Tubes-IF4031-Kel12_JuliusAAT
   cd Tubes-IF4031-Kel12_JuliusAAT
   ```

2. Copy `.env.example` menjadi `.env`, lalu isi seluruh variabel sesuai kebutuhan (lihat bagian [Variabel Konfigurasi](#variabel-konfigurasi)):
   ```bash
   cp .env.example .env
   ```

3. Jalankan seluruh sistem dengan perintah berikut:
   ```bash
   docker compose up --build -d
   ```

4. Verifikasi seluruh services yang dijalankan:
   ```bash
   docker compose ps
   ```

5. Titik akses utama setelah sistem menyala:

   | Service | Port | Keterangan |
   |---|---|---|
   | BMKG (mock) | `8081` | Dipanggil Aggregator, dibuka ke host untuk debugging langsung ke BMKG mock |
   | PVMBG (mock) | `8082` | Dipanggil Aggregator, dibuka ke host sebagai operator demo untuk dapat memicu `POST /admin/outage` dan `POST /admin/schema-version` |
   | BNPB Token Service | `8090` | Login (POST /auth/token) dan refresh (POST /auth/refresh)|
   | Client-Facing API (Client Service) | `8080` | Endpoint yang diakses client downstream |
   | RabbitMQ Management UI | `15672` | Observasi exchange dan queue |
   | Consumer Dashboard | `8101` | GET /state untuk memeriksa event yang sudah dikonsumsi |
   | Consumer Notifier | `8102` | GET /state untuk memeriksa event yang sudah dikonsumsi|

   Aggregator dan seluruh database (Canonical Store, store BMKG/PVMBG, token database) tidak dipublikasikan ke host

## Variabel Konfigurasi

### Database per Instansi

| Variabel | Contoh Nilai | Keterangan |
|---|---|---|
| `POSTGRES_AGGREGATOR_USER` | `admin` | Username Postgres untuk Canonical Store milik Aggregator |
| `POSTGRES_AGGREGATOR_PASSWORD` | — | Password Postgres untuk Canonical Store |
| `POSTGRES_AGGREGATOR_DB` | — | Nama database Canonical Store |
| `POSTGRES_PVMBG_USER` | `admin` | Username Postgres untuk store milik PVMBG mock |
| `POSTGRES_PVMBG_PASSWORD` | — | Password Postgres untuk store milik PVMBG mock |
| `POSTGRES_PVMBG_DB` | — | Nama database store PVMBG mock |
| `POSTGRES_BMKG_USER` | `admin` | Username Postgres untuk store milik BMKG mock |
| `POSTGRES_BMKG_PASSWORD` | — | Password Postgres untuk store milik BMKG mock |
| `POSTGRES_BMKG_DB` | — | Nama database store BMKG mock |

### Instansi Sumber BMKG & PVMBG

| Variabel | Contoh Nilai | Keterangan |
|---|---|---|
| `BMKG_BASE_URL` | `http://bmkg-mock:8081` | Address dasar BMKG mock yang dipanggil Aggregator |
| `PVMBG_BASE_URL` | `http://pvmbg-mock:8082` | Address dasar PVMBG mock yang dipanggil Aggregator |
| `BMKG_API_KEY` | — | API key BMKG, dikirim lewat header `X-BMKG-Key`. |
| `PVMBG_TOKEN` | — | Token JWT (ditandatangani dengan `PVMBG_SECRET_KEY`) yang dipakai Aggregator mengakses PVMBG lewat header `Authorization: Bearer` |
| `PVMBG_SECRET_KEY` | — | Secret key untuk menandatangani dan memverifikasi `PVMBG_TOKEN`|

### BNPB Aggregator

| Variabel | Contoh Nilai | Keterangan |
|---|---|---|
| `POLL_INTERVAL_MS` | `3000` | Interval polling Aggregator ke BMKG dan PVMBG (disarankan spek 2000–5000 ms) |
| `SOURCE_TIMEOUT_MS` | `2000` | Batas waktu tunggu Aggregator saat memanggil BMKG/PVMBG sebelum dianggap gagal |
| `PVMBG_MIN_DELAY` | `500` | Batas bawah delay acak yang disimulasikan PVMBG mock (ms) |
| `PVMBG_MAX_DELAY` | `3000` | Batas atas delay acak yang disimulasikan PVMBG mock (ms). |

### Auth / Token Service

| Variabel | Contoh Nilai | Keterangan |
|---|---|---|
| `TOKEN_DB_PASSWORD` | — | Password database milik Auth/Token Service |
| `JWT_ISSUER` | `bnpb-token` | Claim `iss` pada access token |
| `JWT_AUDIENCE` | `bnpb-client-api` | Claim `aud` pada access token |
| `ACCESS_TOKEN_TTL_SECONDS` | `60` | Masa berlaku access token dalam detik |
| `REFRESH_TOKEN_TTL_SECONDS` | `600` | Masa berlaku refresh token dalam detik |
| `INTROSPECT_SERVICE_KEY` | — | Kunci yang disertakan Client-Facing API lewat header `X-Service-Key` saat memanggil `/auth/introspect` |

### Kredensial Client Downstream

| Variabel | Contoh Nilai | Keterangan |
|---|---|---|
| `MEDIA_CLIENT_ID` / `MEDIA_CLIENT_SECRET` | `media-client` | Kredensial untuk client Media/Pers (scope `summary`) |
| `LAPANGAN_CLIENT_ID` / `LAPANGAN_CLIENT_SECRET` | `lapangan-client` / — | Kredensial untuk client Tim Lapangan (scope `full`) |
| `INTERNAL_CLIENT_ID` / `INTERNAL_CLIENT_SECRET` | `internal-client` / — | Kredensial untuk client BNPB Pusat / Internal Ops (scope `full`) |

### Message Broker

| Variabel | Contoh Nilai | Keterangan |
|---|---|---|
| `RABBITMQ_USER` | — | Username RabbitMQ, dipakai Aggregator (publisher) dan Consumer |
| `RABBITMQ_PASSWORD` | — | Password RabbitMQ |

## Cara Memicu Skenario Pengujian

Sebelum menjalankan Skenario Pengujian, karena pengujian dilakukan di terminal WSL, muat environment variable dulu di setiap sesi terminal baru:

```bash
set -a
source <(tr -d '\r' < .env)
set +a
```

### Problem 1 — Arsitektur & Interoperabilitas Data
1. Amati HazardEvent yang sudah dihasilkan dari skema awal (field confidence_level belum ada):
```bash
docker compose exec store-aggregator psql -U "$POSTGRES_AGGREGATOR_USER" -d "$POSTGRES_AGGREGATOR_DB" \
  -c "SELECT hazard_id, attributes->>'confidence_level' AS confidence_level FROM hazard_events WHERE hazard_type='VOLCANIC' ORDER BY occurred_at DESC LIMIT 5;"
```
2. Picu perubahan skema PVMBG saat sistem sedang berjalan,
```bash
curl -i -X POST http://localhost:8082/admin/schema-version \
  -H "Authorization: Bearer $PVMBG_TOKEN" -H "Content-Type: application/json" \
  -d '{"confidence": true}'
```
3. Tunggu beberapa siklus polling (berdasarkan POLL_INTERVAL_MS), kemudian cek log Aggregator untuk memastikan tidak ada error
```bash
docker compose logs aggregator --since 1m | tail -n 30
```
4. Ulangi query pada langkah 1, record baru seharusnya akan memiliki confidence_level sedangkan record lama tidak

### Problem 2 — Concurrency, Availability, & Graceful Degradation
**Load Testing**
```
k6 run --summary-export=result.json load_test.js
```

**Simulasi Outage PVMBG**
1. Login ke sistem dan simpan token yang di-generate:
```bash
RESP=$(curl -s -X POST http://localhost:8090/auth/token -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$LAPANGAN_CLIENT_ID\",\"client_secret\":\"$LAPANGAN_CLIENT_SECRET\"}")
ACCESS_TOKEN=$(echo "$RESP" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
REFRESH_TOKEN=$(echo "$RESP" | grep -o '"refresh_token":"[^"]*"' | cut -d'"' -f4)
```
2. Nyalakan Outage pada PVMBG mock service:
```bash
curl -i -X POST http://localhost:8082/admin/outage -H "Authorization: Bearer $PVMBG_TOKEN" \
  -H "Content-Type: application/json" -d '{"outage": true}'
```
3. Lakukan permintaan data seismik pada Client-Facing API, dengan ekspektasi mengembalikan hasil data seismik dengan status code 200 (normal)
```bash
curl -i "http://localhost:8080/data?hazard_type=SEISMIC" -H "Authorization: Bearer $ACCESS_TOKEN"
```
4. Lakukan permintaan data vulkanik pada Client-Facing API, dengan ekspektasi mengembalikan hasil data vulkanik terakhir dengan field stale_since dan status code 200
```bash
curl -i "http://localhost:8080/data?hazard_type=VOLCANIC" -H "Authorization: Bearer $ACCESS_TOKEN"
```
5. Tampilkan log client-service untuk kedua permintaan di atas berisi correlation ID:
```bash
docker compose logs client-service --since 15m | grep '"path":"/data"'
```
6. Tampilkan log aggregator untuk kedua permintaan data di atas dengan correlation ID yang sama yang diteruskan dari client-service:
```bash
docker compose logs aggregator --since 15m | grep '"path":"/hazard-events'
```
7. Tampilkan log aggregator tanpa filter selama outage berlangsung, akan terlihat polling PVMBG yang gagal berulang, tetapi polling BMKG berhasil
```bash
docker compose logs aggregator --since 2m | tail -n 40
```
9. Matikan outage pada PVMBG, kemudian ulangi langkah 4. stale_since secara ekspektasi akan hilang atau mengembalikan hasil data vulkanik secara normal
```bash
curl -i -X POST http://localhost:8082/admin/outage -H "Authorization: Bearer $PVMBG_TOKEN" \
  -H "Content-Type: application/json" -d '{"outage": false}'
```

### Problem 3 — Service-to-Service Authentication & Trust
**Kredensial tidak tertukar antar instansi**
Lakukan percobaan berikut
```bash
curl -i http://localhost:8081/seismic-events?since=1970-01-01T00:00:00.000Z -H "X-BMKG-Key: $PVMBG_TOKEN"
curl -i http://localhost:8082/volcanic-reports?since=1970-01-01T00:00:00.000Z -H "Authorization: Bearer $BMKG_API_KEY"
```
Hasil percobaan tersebut akan ditolak dengan status code 401/403

**Client scope Media ditolak mengakses field mentah:**
```bash
RESP=$(curl -s -X POST http://localhost:8090/auth/token -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$MEDIA_CLIENT_ID\",\"client_secret\":\"$MEDIA_CLIENT_SECRET\"}")
MEDIA_ACCESS_TOKEN=$(echo "$RESP" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)

curl -i "http://localhost:8080/data?fields=latitude,attributes" -H "Authorization: Bearer $MEDIA_ACCESS_TOKEN"
```

Hasil pengujian tersebut akan mengembalikan status code 403 dengan error insufficient_scope

**Refresh token dan penolakan token lama**
1. Login sebagai Tim Lapangan kemudian lakukan percobaan pengambilan data seperti berikut:
```bash
TOKEN_RESPONSE=$(curl -sS -X POST "http://localhost:8090/auth/token" \
  -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$LAPANGAN_CLIENT_ID\",\"client_secret\":\"$LAPANGAN_CLIENT_SECRET\"}")
ACCESS_TOKEN=$(printf '%s' "$TOKEN_RESPONSE" | jq -r '.access_token')
REFRESH_TOKEN=$(printf '%s' "$TOKEN_RESPONSE" | jq -r '.refresh_token')

curl -i "http://localhost:8080/data?fields=hazard_id,source,latitude,longitude,attributes" -H "Authorization: Bearer $ACCESS_TOKEN"
```
2. Tunggu ACCESS_TOKEN_TTL_SECONDS detik sampai token kedaluwarsa, kemudian lakukan ulang query pengambilan data pada langkah 1 dengan token lama, dengan ekspektasi mendapat error code 401 invalid_token
```bash
curl -i "http://localhost:8080/data?fields=hazard_id,source,latitude,longitude,attributes" -H "Authorization: Bearer $ACCESS_TOKEN"
```

3. Lakukan refresh token seperti berikut kemudian coba ulangi query pengambilan data dengan akses token baru
```bash
REFRESH_RESPONSE=$(curl -sS -X POST "http://localhost:8090/auth/refresh" \
  -H "Content-Type: application/json" \
  -d "{\"refresh_token\":\"$REFRESH_TOKEN\"}")
NEW_ACCESS_TOKEN=$(printf '%s' "$REFRESH_RESPONSE" | jq -r '.access_token')
NEW_REFRESH_TOKEN=$(printf '%s' "$REFRESH_RESPONSE" | jq -r '.refresh_token')

curl -i "http://localhost:8080/data?fields=hazard_id,source,latitude,longitude,attributes" -H "Authorization: Bearer $NEW_ACCESS_TOKEN"

```
4. Coba lakukan query pengambilan data yang sama, tetapi dengan access token lama. Ekspektasi hasil mengembalikan error code 401, artinya token lama ditolak setelah refresh

### Problem 4 — Arsitektur Microservice & Flexible Storage
**Rebuild satu service tanpa mengganggu yang lain**
1. Buka dua terminal. Pada terminal 1, tampilkan status dari container-container docker pada sistem:
```bash
docker compose ps
```
2. Pada terminal 2, login untuk mendapatkan access token:
```bash
RESP=$(curl -s -X POST http://localhost:8090/auth/token -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$LAPANGAN_CLIENT_ID\",\"client_secret\":\"$LAPANGAN_CLIENT_SECRET\"}")
ACCESS_TOKEN=$(echo "$RESP" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
```
3. Selanjutnya pada terminal 2, jalankan loop observasi ke endpoint yang independen dari service yang direbuild (contohnya query data seismik pada Client Facing API)
```bash
while true; do printf "%s" "$(date +%T)"; curl -s -o /dev/null -w "  /data -> %{http_code}\n" \
  "http://localhost:8080/data?hazard_type=SEISMIC" -H "Authorization: Bearer $ACCESS_TOKEN"; sleep 1; done

```
4. Pada terminal 1, lakukan rebuild pada service yang endpointnya tidak ditembak pada loop observasi terminal 2, seperti pvmbg-mock:
```bash
docker compose up -d --build --no-deps pvmbg-mock
```
5. Amati terminal 2 bersamaan ketika terminal 1 melakukan rebuild, deretan status code 200 secara ekspektasi tidak terputus selama rebuild. 
6. Ketika selesai rebuild, jalankan ulang docker compose ps di terminal 1, uptime container selain service yang direbuild (contoh di sini pvmbg-mock) tidak berubah

**Record sebelum dan sesudah perubahan skema tersimpan berdampingan**
Lakukan pengujian yang sama seperti pada problem 1, tetapi tampilan kondisi record sesudah perubahan skema ditunggu beberapa detik hingga terjadi siklus polling pertama setelah perubahan skema
 
**Canonical Store hanya diakses Aggregator**
- Lakukan percobaan aggregator mengakses store-aggregator (resolve nama dan buka koneksi TCP), hasil dari pengujian ini harus bernilai SUCCESS
```bash
docker compose exec aggregator sh -c 'getent hosts store-aggregator && echo "SUCCESS" || echo "FAIL"'
docker compose exec aggregator sh -c 'timeout 3 bash -c "</dev/tcp/store-aggregator/5432" && echo SUCCESS || echo FAIL'
```
- Lakukan percobaan Client-Service mengakses (resolve nama) dari store aggregator, hasil nya harus FAIL
```bash
docker compose exec client-service sh -c 'getent hosts store-aggregator && echo "SUCCESS" || echo "FAIL"'
```
- Lakukan pembuktian Client Service tetap bisa memperoleh data HazardEvent melalui API Aggregator
```bash
docker compose exec client-service wget -qO- "http://aggregator:8090/hazard-events?hazard_type=SEISMIC"

```
### Problem 5 — Fan-out Event Distribution/Pub-sub
**Dua consumer menerima event dari producer**
1. Buka tiga terminal, jalankan command log untuk kontainer pada masing-masing terminal:
```docker compose logs -f --tail=100 aggregator```
```docker compose logs -f --tail=100 consumer-dashboard```
```docker compose logs -f --tail=100 consumer-notifier```
2. Amati jika log aggregator menunjukkan baris ```Event published with key: hazard.<type>.<severity>.``` Log consumer-dashboard dan consumer-notifier masing-masing menunjukkan event diterima dengan correlation_id yang sama dengan event yang baru dipublikasikan. Ini membuktikan kedua consumer menerima event yang sama secara independen, tanpa Aggregator pernah tahu keberadaan mereka.

**Mematikan salah satu consumer, lalu menyalakannya kembali**
1. Matikan service consumer-dashboard
```docker compose down consumer-dashboard```
2. Lihat kembali terminal log consumer-notifier pada langkah sebelumnya (tiga terminal), ekspektasi tetap menerima event ALERT secara normal
3. Hentikan consumer-notifier (dengan stop agar data tidak hilang):
``` docker compose stop consumer-notifier```
4. Cek antrian pesan yang menumpuk karena consumer-notifier tidak aktif, sementara producer tetap berjalan, di sini kolom messages_ready pada queue notifier akan terus bertambah:
```
docker compose exec rabbitmq rabbitmqctl list_queues name durable messages_ready messages_unacknowledged
```
5. Nyalakan kembali consumer-notifier dengan ```docker compose start consumer-notifier``` kemudian ulangi langkah 4, messages_ready kembali ke 0 sebagai bukti pesan yang menumpuk selama consumer mati bisa disusulkan (hanya tertunda)
```

**Menambahkan consumer baru tanpa mengubah kode producer**
1. Tambahkan satu service baru di compose.yml (misalnya consumer-portal-pemda), dengan kredensial RABBITMQ_URL, QUEUE_NAME, dan BINDINGS milik sendiri sesuai pola pada consumer sebelumnya
2. Jalankan service consumer yang baru dibuat:
```bash
docker compose up -d --no-deps --force-recreate consumer-portal-pemda
```
3. Cek log service consumer tersebut yang langsung menerima event dari producer
```bash
 docker compose logs -f --tail=50 consumer-portal-pemda
  ```
4. Cek queue baru yang muncul di RabbitMQ dan menerima pesan sesuai binding yang didefinisikan
```bash
docker compose exec rabbitmq rabbitmqctl list_queues name durable messages_ready messages_unacknowledged
```

## Kelompok 12 - JuliusAAT

| NIM | Nama | Pembagian Tugas |
| :---: | :---: | :--- |
| 13523023 | Muhammad Aufa Farabi | *Implementasi Aggregator Service dari BNPB, dan canonical store, Laporan* |
| 13523030 | Julius Arthur | *Implementasi BNPB Token Service, Client Service, serta publisher dan consumer, Laporan* |
| 13523051 | Ferdinand Gabe Tua Sinaga | *Implementasi mock BMKG dan PVMBG, serta store terkait untuk masing-masing service , Laporan* |
