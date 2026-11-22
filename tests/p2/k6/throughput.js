// P2 kriteria 7: throughput 3 instance >= 2,0x throughput 1 instance.
// Beban loop tertutup tanpa jeda (VU langsung mengulang), jumlah VU tetap, mencetak laju permintaan sukses.
// Dijalankan oleh tests/p2/07-throughput.sh dua kali (1 replika, lalu 3 replika) dan hasilnya dibandingkan.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://aggregator:8090';
const VUS = Number(__ENV.VUS || 300);
const DURATION = __ENV.DURATION || '60s';
const ok200 = new Counter('ok_200');
const non200 = new Counter('non_200');

export const options = {
  scenarios: { closed_loop: { executor: 'constant-vus', vus: VUS, duration: DURATION } },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};
const PATHS = ['/hazard-events?hazard_type=SEISMIC&limit=20', '/hazard-events?hazard_type=VOLCANIC&limit=20', '/hazard-events?limit=20'];

export default function () {
  const r = http.get(`${BASE}${PATHS[Math.floor(Math.random() * PATHS.length)]}`, { timeout: '15s' });
  if (check(r, { 'status 200': (x) => x.status === 200 })) ok200.add(1); else non200.add(1);
}

export function handleSummary(data) {
  const m = data.metrics;
  const secs = (data.state && data.state.testRunDurationMs ? data.state.testRunDurationMs : 0) / 1000;
  const okCount = m.ok_200 ? m.ok_200.values.count : 0;
  const line = {
    vus: VUS, seconds: Math.round(secs), ok: okCount, non_200: m.non_200 ? m.non_200.values.count : 0,
    rps_ok: secs ? Math.round((okCount / secs) * 10) / 10 : 0,
    p95_ms: m.http_req_duration ? Math.round(m.http_req_duration.values['p(95)']) : null,
  };
  return { stdout: `\nSUMMARY_JSON ${JSON.stringify(line)}\n` };
}
