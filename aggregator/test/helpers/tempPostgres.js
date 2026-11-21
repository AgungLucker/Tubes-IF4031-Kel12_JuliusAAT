// Starts a throw-away PostgreSQL server in a temp directory for the tests.
// Needs initdb / pg_ctl on PATH (or PG_BIN pointing at the bin directory).
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");

const bin = (name) => (process.env.PG_BIN ? path.join(process.env.PG_BIN, name) : name);

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

function postgresAvailable() {
    try {
        execFileSync(bin("pg_ctl"), ["--version"], { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

async function startTempPostgres(databases = []) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aggpg-"));
    const port = await freePort();
    execFileSync(bin("initdb"), ["-D", dir, "-U", "postgres", "-A", "trust", "-E", "UTF8", "--no-sync"], { stdio: "ignore" });
    execFileSync(
        bin("pg_ctl"),
        ["-D", dir, "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off`,
            "-l", path.join(dir, "server.log"), "-w", "start"],
        { stdio: "ignore" }
    );

    const url = (db) => `postgres://postgres@127.0.0.1:${port}/${db}`;
    const admin = new Client({ connectionString: url("postgres") });
    await admin.connect();
    for (const db of databases) await admin.query(`CREATE DATABASE ${db}`);
    await admin.end();

    return {
        port,
        url,
        async stop() {
            try {
                execFileSync(bin("pg_ctl"), ["-D", dir, "-m", "immediate", "-w", "stop"], { stdio: "ignore" });
            } finally {
                fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
            }
        },
    };
}

module.exports = { startTempPostgres, postgresAvailable };
