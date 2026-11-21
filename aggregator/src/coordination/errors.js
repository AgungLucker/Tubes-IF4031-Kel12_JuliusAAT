class FencedError extends Error {
    constructor(source, epoch, detail = "") {
        super(`fenced: ${source} epoch ${epoch} is stale${detail ? ` (${detail})` : ""}`);
        this.name = "FencedError";
        this.source = source;
        this.epoch = epoch;
    }
}

module.exports = { FencedError };
