type LogLevel = "debug" | "info" | "warn" | "error";

// Keeps pure bidding-core log calls self-contained inside the trading workspace.
function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const isTestRun =
        process.env.VITEST === "true" || process.env.NODE_ENV === "test";
    if (isTestRun && (level === "debug" || level === "info")) {
        return;
    }

    const line = JSON.stringify({
        t: new Date().toISOString(),
        level,
        msg: `[bidding] ${message}`,
        ...(meta ?? {}),
    });

    if (level === "warn" || level === "error") {
        console.error(line);
        return;
    }

    console.log(line);
}

export const biddingLog = {
    debug(message: string, meta?: Record<string, unknown>): void {
        emit("debug", message, meta);
    },
    info(message: string, meta?: Record<string, unknown>): void {
        emit("info", message, meta);
    },
    warn(message: string, meta?: Record<string, unknown>): void {
        emit("warn", message, meta);
    },
    error(message: string, meta?: Record<string, unknown>): void {
        emit("error", message, meta);
    },
};
