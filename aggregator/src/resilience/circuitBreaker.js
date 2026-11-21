// Circuit breaker for an unreliable upstream ("stop knocking on a door that never opens").
//
//   CLOSED     calls go through; consecutive failures are counted.
//   OPEN       calls are refused locally, with no network traffic at all, until the cool-down ends.
//   HALF_OPEN  exactly ONE probe call is allowed. Success -> CLOSED. Failure -> OPEN again with a
//              longer cool-down (exponential back-off with jitter, capped at maxOpenMs).
//
// Back-off matters: a fixed cool-down would send a steady trickle of probes to a source that is
// down for hours; doubling it makes the request rate to a dead source fall over time.
class CircuitOpenError extends Error {
    constructor(name, retryInMs) {
        super(`circuit '${name}' open, retry in ${Math.ceil(retryInMs / 1000)}s`);
        this.name = "CircuitOpenError";
        this.retryInMs = retryInMs;
    }
}

class CircuitBreaker {
    constructor({
        name,
        failureThreshold = Number(process.env.BREAKER_FAILURES || 3),
        openMs = Number(process.env.BREAKER_OPEN_MS || 5000),
        maxOpenMs = Number(process.env.BREAKER_MAX_OPEN_MS || 60000),
        jitter = 0.2,
        now = Date.now,
        random = Math.random,
        onChange = () => {},
    }) {
        Object.assign(this, { name, failureThreshold, baseOpenMs: openMs, maxOpenMs, jitter, now, random, onChange });
        this.state = "closed";
        this.failures = 0;
        this.currentOpenMs = openMs;
        this.openUntil = 0;
        this.probing = false;
        this.lastFailure = null;
        this.openedAt = null;
    }

    _set(state) {
        if (state === this.state) return;
        const from = this.state;
        this.state = state;
        this.onChange({ name: this.name, from, to: state });
    }

    _open() {
        const spread = this.currentOpenMs * this.jitter;
        this.openUntil = this.now() + this.currentOpenMs + (this.random() * 2 - 1) * spread;
        this.openedAt ??= this.now();
        this._set("open");
        this.currentOpenMs = Math.min(this.currentOpenMs * 2, this.maxOpenMs);
    }

    async exec(fn) {
        if (this.state === "open") {
            const left = this.openUntil - this.now();
            if (left > 0) throw new CircuitOpenError(this.name, left);
            this._set("half_open");
        }
        let probe = false;
        if (this.state === "half_open") {
            if (this.probing) throw new CircuitOpenError(this.name, this.baseOpenMs);
            this.probing = probe = true;
        }

        try {
            const result = await fn();
            this.failures = 0;
            this.currentOpenMs = this.baseOpenMs;
            this.openedAt = null;
            this.lastFailure = null;
            this._set("closed");
            return result;
        } catch (err) {
            this.lastFailure = err.message;
            if (this.state === "half_open") {
                this._open();
            } else if (++this.failures >= this.failureThreshold) {
                this._open();
            }
            throw err;
        } finally {
            if (probe) this.probing = false;
        }
    }

    snapshot() {
        return {
            name: this.name, state: this.state, failures: this.failures,
            retryInMs: this.state === "open" ? Math.max(0, this.openUntil - this.now()) : 0,
            openedAt: this.openedAt, lastFailure: this.lastFailure,
        };
    }
}

module.exports = { CircuitBreaker, CircuitOpenError };
