export type LogLevel = "debug" | "info" | "warn" | "error";

function ts() {
    return new Date().toISOString();
}

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    const base = { t: ts(), level, msg } as Record<string, unknown>;
    if (meta) Object.assign(base, meta);
    const line = JSON.stringify(base);
    if (level === "error" || level === "warn") {
        console.error(line);
    } else {
        console.log(line);
    }
}

export const logger = {
    debug: (msg: string, meta?: Record<string, unknown>) =>
        log("debug", msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) =>
        log("info", msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) =>
        log("warn", msg, meta),
    error: (msg: string, meta?: Record<string, unknown>) =>
        log("error", msg, meta),
};
