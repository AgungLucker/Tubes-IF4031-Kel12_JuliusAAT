const VOLCANOES = {
    V001: { name: "Gunung Merapi", latitude: -7.5407, longitude: 110.4457 },
    V002: { name: "Gunung Kelud", latitude: -7.9308, longitude: 112.3083 },
    V003: { name: "Gunung Semeru", latitude: -8.1080, longitude: 112.9220 },
    V004: { name: "Gunung Agung", latitude: -8.3425, longitude: 115.5081 },
    V005: { name: "Gunung Sinabung", latitude: 3.1700, longitude: 98.3920 },
    V006: { name: "Gunung Krakatau", latitude: -6.1022, longitude: 105.4230 },
    V007: { name: "Gunung Bromo", latitude: -7.9425, longitude: 112.9530 },
    V008: { name: "Gunung Ijen", latitude: -8.0580, longitude: 114.2420 }
};

function getVolcanoInfo(volcanoId) {
    return VOLCANOES[volcanoId] ?? { name: `Unknown (${volcanoId})`, latitude: null, longitude: null };
}

module.exports = { getVolcanoInfo };
