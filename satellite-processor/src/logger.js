const base = (level) => (o) =>
    console.log(JSON.stringify({ ts: new Date().toISOString(), level, service: "SATELLITE-PROCESSOR", ...o }));

const log = { info: base("info"), error: base("error") };

module.exports = { log };
