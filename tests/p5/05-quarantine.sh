#!/usr/bin/env bash
# P5 kriteria 2: data yang melanggar kontrak dasar TIDAK tersimpan sebagai HazardEvent, melainkan disisihkan
# beserta alasannya. Hanya membaca; aman dijalankan kapan saja, dan paling bermakna setelah 01-sensor-probe /
# game day (saat sensor mengirim data rusak).
. "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
need kubectl python3

log "1) Tidak ada HazardEvent SENSOR_PANTAI yang melanggar kontrak/kewajaran di shard mana pun"
tot=0; viol=0
for s in 1 2 3; do
  r=$(shard_sql "$s" "
    select count(*) filter (where source='SENSOR_PANTAI') as total,
           count(*) filter (where source='SENSOR_PANTAI' and (
                attributes->>'quality' is distinct from 'ok'
             or jsonb_typeof(attributes->'critical') is distinct from 'boolean'
             or jsonb_typeof(attributes->'wave_height_m') is distinct from 'number'
             or jsonb_typeof(attributes->'sea_level_anomaly_m') is distinct from 'number'
             or case when jsonb_typeof(attributes->'wave_height_m')='number' then ((attributes->>'wave_height_m')::numeric < 0 or (attributes->>'wave_height_m')::numeric > 60) else true end
             or case when jsonb_typeof(attributes->'sea_level_anomaly_m')='number' then abs((attributes->>'sea_level_anomaly_m')::numeric) > 30 else true end
             or area_name is null or latitude is null or longitude is null)) as melanggar
    from hazard_events" 2>/dev/null)
  IFS='|' read -r t v <<<"$r"; tot=$((tot + ${t:-0})); viol=$((viol + ${v:-0}))
  info "shard-$s: SENSOR_PANTAI total=${t:-?} melanggar=${v:-?}"
done
[ "$viol" -eq 0 ] && ok "0 dari $tot HazardEvent sensor melanggar kontrak" || bad "$viol HazardEvent sensor melanggar kontrak (lolos validator)"

log "2) Pesan yang disisihkan: ada alasan, sumber, waktu, dan isi utuh"
ingest_sql "select split_part(reason,':',1) as kelas, retryable, status, count(*) from rejected_messages where source='SENSOR_PANTAI' group by 1,2,3 order by 4 desc" | sed 's/^/     /'
n=$(ingest_sql "select count(*) from rejected_messages where source='SENSOR_PANTAI'")
bad_rows=$(ingest_sql "select count(*) from rejected_messages where source='SENSOR_PANTAI' and (reason is null or reason='' or received_at is null or octet_length(raw_payload)=0)")
info "total disisihkan: $n"
[ "${bad_rows:-0}" -eq 0 ] && ok "setiap pesan yang disisihkan punya alasan, waktu terima, dan isi mentah utuh" || bad "$bad_rows pesan yang disisihkan tidak lengkap"
echo "-- contoh alasan:"; ingest_sql "select distinct on (split_part(reason,':',1)) reason from rejected_messages where source='SENSOR_PANTAI' order by split_part(reason,':',1), received_at desc limit 8" | sed 's/^/     /'

log "3) Pesan yang disisihkan tidak muncul sebagai HazardEvent (silang-periksa dengan source_ref_id)"
ingest_sql "select source_ref_id from rejected_messages where source='SENSOR_PANTAI' and source_ref_id is not null" | sort -u > "$RESULTS_DIR/rejected_refs.txt"
for s in 1 2 3; do shard_sql "$s" "select source_ref_id from hazard_events where source='SENSOR_PANTAI'" 2>/dev/null; done | sort -u > "$RESULTS_DIR/stored_refs.txt"
both=$(comm -12 "$RESULTS_DIR/rejected_refs.txt" "$RESULTS_DIR/stored_refs.txt" | wc -l | tr -d ' ')
[ "$both" -eq 0 ] && ok "tidak ada observation_id yang sekaligus disisihkan dan tersimpan" || info "$both observation_id ada di kedua tempat (mungkin diperbaiki/diputar ulang oleh replay; periksa status 'recovered')"
finish
