const CONFIDENCE_RANK = { l: 0, n: 1, h: 2 };

const toMs = (value) => new Date(value).getTime();

function summarizeFire(members) {
    const times = members.map((member) => toMs(member.detected_at));
    const sum = (field) => members.reduce((total, member) => total + member[field], 0);

    return {
        // asumsi titik pusat rata-rata langitude dan longitude
        latitude: sum("latitude") / members.length,
        longitude: sum("longitude") / members.length,
        detection_count: members.length,
        satellites: [...new Set(members.map((member) => member.satellite))].sort(),
        max_confidence: members.reduce(
            (best, member) => CONFIDENCE_RANK[member.confidence] > CONFIDENCE_RANK[best] ? member.confidence : best,
            members[0].confidence
        ),
        total_frp_mw: sum("frp_mw"),
        earliest_detected_at: new Date(Math.min(...times)),
        latest_detected_at: new Date(Math.max(...times)),
    };
}

module.exports = { summarizeFire };
