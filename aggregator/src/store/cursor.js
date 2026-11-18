class CursorError extends Error {}

function encodeCursor(obj) {
    return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function decodeCursor(cursor, requiredKeys) {
    if (cursor === undefined || cursor === null || cursor === "") return null;
    let obj;
    try {
        obj = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    } catch {
        throw new CursorError("cursor tidak valid");
    }
    for (const k of requiredKeys) {
        if (typeof obj?.[k] !== "string") throw new CursorError("cursor tidak valid");
    }
    return obj;
}

module.exports = { encodeCursor, decodeCursor, CursorError };
