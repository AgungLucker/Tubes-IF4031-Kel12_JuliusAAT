function mapFeedEventToDetection({ offset, detection }) {
    const { satellite, acq_date, acq_time, latitude, longitude, confidence, frp } = detection;

    const detectionKey = [
        satellite,
        acq_date,
        acq_time,
        latitude.toFixed(5),
        longitude.toFixed(5),
    ].join("|");

    const paddedTime = String(acq_time).padStart(4, "0");

    return {
        detection_key: detectionKey,
        satellite,
        detected_at: `${acq_date}T${paddedTime.slice(0, 2)}:${paddedTime.slice(2)}:00Z`,
        latitude,
        longitude,
        confidence,
        frp_mw: frp,
        feed_offset: offset,
    };
}

module.exports = { mapFeedEventToDetection };
