import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { log } from './logger.js';

const cfg = loadConfig();
createApp({ cfg }).listen(cfg.port, () => log.info({ event: 'startup', port: cfg.port }));
