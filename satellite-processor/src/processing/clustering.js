const LINK_MAX_DISTANCE_KM = 1.0;
const LINK_MAX_TIME_DIFF_MS = 360 * 60 * 1000;
const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;
const toMs = (value) => new Date(value).getTime();

// haversine function distance (km)
function distanceKm(a, b) {
    const dLat = toRad(b.latitude - a.latitude);
    const dLon = toRad(b.longitude - a.longitude);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function groupLinkedDetections(detections) {
    // ordered by detection time
    const sortedEntries = detections
        .map((detection) => ({ detection, timeMs: toMs(detection.detected_at) }))
        .sort((first, second) =>
            first.timeMs - second.timeMs ||
            (first.detection.detection_key < second.detection.detection_key ? -1 : 1));

    const groupParent = sortedEntries.map((_, index) => index);
    const findGroupRoot = (index) => {
        while (groupParent[index] !== index) {
            groupParent[index] = groupParent[groupParent[index]];
            index = groupParent[index];
        }
        return index;
    };
    const joinGroups = (a, b) => { groupParent[findGroupRoot(a)] = findGroupRoot(b); };

    for (let current = 0; current < sortedEntries.length; current++) {
        // ordered by time
        for (
            let other = current + 1;
            other < sortedEntries.length &&
            sortedEntries[other].timeMs - sortedEntries[current].timeMs <= LINK_MAX_TIME_DIFF_MS;
            other++
        ) {
            if (distanceKm(sortedEntries[current].detection, sortedEntries[other].detection) <= LINK_MAX_DISTANCE_KM) {
                joinGroups(current, other);
            }
        }
    }

    const groupsByRoot = new Map();
    sortedEntries.forEach((entry, index) => {
        const groupRoot = findGroupRoot(index);
        if (!groupsByRoot.has(groupRoot)) groupsByRoot.set(groupRoot, []);
        groupsByRoot.get(groupRoot).push(entry.detection);
    });
    return [...groupsByRoot.values()];
}

module.exports = { distanceKm, groupLinkedDetections, LINK_MAX_TIME_DIFF_MS };