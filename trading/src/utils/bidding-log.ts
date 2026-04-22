import { logger } from "@artgod/shared/utils/logger";

type LogLevel = "debug" | "info" | "warn" | "error";

// Routes bidding-core logs through ArtGod's shared process logger.
function emit(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
): void {
    const isTestRun =
        process.env.VITEST === "true" || process.env.NODE_ENV === "test";
    if (isTestRun && (level === "debug" || level === "info")) {
        return;
    }

    const payload = meta ? { ...meta } : undefined;
    const prefixed = `[bidding] ${message}`;

    switch (level) {
        case "debug":
            logger.debug(prefixed, payload);
            return;
        case "info":
            logger.info(prefixed, payload);
            return;
        case "warn":
            logger.warn(prefixed, payload);
            return;
        case "error":
            logger.error(prefixed, payload);
            return;
    }
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
