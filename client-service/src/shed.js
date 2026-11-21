import { HttpError } from './error.js';
import { log } from './logger.js';

export function createShedder({ maxInflight, mediaShare, onShed = () => {} }) {
  const lowLimit = Math.max(1, Math.floor(maxInflight * mediaShare));
  let inflight = 0;
  const shed = { high: 0, low: 0 };
  const admitted = { high: 0, low: 0 };

  function admit(req, res, next) {
    const prio = req.priority === 'high' ? 'high' : 'low';
    const limit = prio === 'high' ? maxInflight : lowLimit;
    if (inflight >= limit) {
      shed[prio] += 1;
      onShed(prio);
      log.info({ event: 'shed', priority: prio, inflight, client_id: req.auth?.clientId });
      res.set('Retry-After', '1');
      return next(new HttpError(429, 'rate_limited', 'Server is overloaded, retry shortly'));
    }
    inflight += 1;
    admitted[prio] += 1;
    let released = false;
    const release = () => { if (!released) { released = true; inflight -= 1; } };
    res.on('finish', release);
    res.on('close', release);
    next();
  }

  return { admit, stats: () => ({ inflight, lowLimit, maxInflight, shed: { ...shed }, admitted: { ...admitted } }) };
}

export function prioritize(cfg) {
  return function setPriority(req, res, next) {
    const id = req.auth?.clientId;
    req.priority = id === cfg.lapanganClientId || id === cfg.internalClientId ? 'high' : 'low';
    next();
  };
}
