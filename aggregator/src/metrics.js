// Tiny Prometheus text-format registry (no dependency): counters, gauges and histograms with labels.
// Exposed at GET /metrics so a failure can be explained from numbers, not guesses.
const counters = new Map();
const gauges = new Map();
const histograms = new Map();
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

const key = (name, labels) => `${name}${fmt(labels)}`;
const esc = (v) => String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
function fmt(labels = {}) {
    const e = Object.entries(labels);
    return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}` : "";
}

function inc(name, labels = {}, by = 1) {
    const k = key(name, labels);
    counters.set(k, (counters.get(k) || 0) + by);
}

function setGauge(name, value, labels = {}) {
    gauges.set(key(name, labels), value);
}

function observe(name, seconds, labels = {}) {
    const k = key(name, labels);
    let h = histograms.get(k);
    if (!h) histograms.set(k, (h = { name, labels, counts: BUCKETS.map(() => 0), sum: 0, count: 0 }));
    h.sum += seconds;
    h.count += 1;
    BUCKETS.forEach((b, i) => { if (seconds <= b) h.counts[i] += 1; });
}

function render() {
    const out = [];
    for (const [k, v] of counters) out.push(`${k} ${v}`);
    for (const [k, v] of gauges) out.push(`${k} ${v}`);
    for (const h of histograms.values()) {
        BUCKETS.forEach((b, i) => out.push(`${h.name}_bucket${fmt({ ...h.labels, le: b })} ${h.counts[i]}`));
        out.push(`${h.name}_bucket${fmt({ ...h.labels, le: "+Inf" })} ${h.count}`);
        out.push(`${h.name}_sum${fmt(h.labels)} ${h.sum}`);
        out.push(`${h.name}_count${fmt(h.labels)} ${h.count}`);
    }
    return out.join("\n") + "\n";
}

function reset() { counters.clear(); gauges.clear(); histograms.clear(); }

module.exports = { inc, setGauge, observe, render, reset };
