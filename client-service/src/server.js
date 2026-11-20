import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { log } from './logger.js';
import { startPublisher } from './publisher.js';

const cfg = loadConfig();
startPublisher();
createApp({ cfg }).listen(cfg.port, () => log.info({ event: 'startup', port: cfg.port }));
