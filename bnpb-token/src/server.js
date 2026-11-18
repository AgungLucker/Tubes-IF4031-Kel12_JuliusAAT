import { loadConfig } from './config.js';
import { loadKeys } from './keys.js';
import { createPool, initDb } from './db.js';
import { createTokenService } from './tokenService.js';
import { createApp } from './app.js';
import { log } from './logger.js';

const cfg = loadConfig();
const keys =  loadKeys(cfg);
const pool = createPool(cfg.databaseUrl);

async function start() {
    while (true) {
        try {
            await initDb(pool);
            const tokens = await createTokenService({ pool, cfg, keys });
            const app = createApp({ cfg, keys, tokens });
            app.listen(cfg.port, () =>
                log.info({ event: 'startup', port: cfg.port }));
            return;
        } catch (error) {
            log.error({ event: 'database_startup_failed', message: error.message });
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

await start();