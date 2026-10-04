import { loadConfig } from './config.js';
import { loadKeys } from './keys.js';
import { createPool, initDb } from './db.js';
import { createTokenService } from './tokenService.js';
import { createApp } from './app.js';
import { log } from './logger.js';

const cfg = loadConfig();
const keys =  loadKeys(cfg);
const pool = createPool(cfg.databaseUrl);
await initDb(pool);
const tokens = await createTokenService({ pool, cfg, keys });
const app = createApp({ cfg, keys, tokens });

app.listen(cfg.port, () => 
  log.info({ event: 'startup', port: cfg.port, }));