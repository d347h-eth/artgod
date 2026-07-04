import { logger } from "@artgod/shared/utils/logger";

type LogLevel = "debug" | "info" | "warn" | "error";

// Canonical component labels used by Alloy/Loki for trading bot log routing.
export const BIDDING_LOG_COMPONENT = {
    Bidder: "Bidder",
    BidderRefresh: "BidderRefresh",
    BiddingBidBookProjection: "BiddingBidBookProjection",
    BiddingBotRuntime: "BiddingBotRuntime",
    BiddingCommandReconciliationLoop: "BiddingCommandReconciliationLoop",
    BiddingCommandReconciler: "BiddingCommandReconciler",
    BiddingCommandSignalListener: "BiddingCommandSignalListener",
    BiddingRuntime: "BiddingRuntime",
    CollectionOfferSnapshotRefresh: "CollectionOfferSnapshotRefresh",
    CollectionOfferSnapshotService: "CollectionOfferSnapshotService",
    HotRefreshBackpressure: "HotRefreshBackpressure",
    OpenSeaBiddingService: "OpenSeaBiddingService",
    OpenSeaCollectionOfferSource: "OpenSeaCollectionOfferSource",
    OpenSeaEventStream: "OpenSeaEventStream",
    OpenSeaSdk: "OpenSeaSdk",
    SqliteBiddingBidBookProjection: "SqliteBiddingBidBookProjection",
    WethAllowanceApprovalService: "WethAllowanceApprovalService",
} as const;

// Trading bot component labels are intentionally stable Loki dimensions.
export type BiddingLogComponent =
    (typeof BIDDING_LOG_COMPONENT)[keyof typeof BIDDING_LOG_COMPONENT];

// Additional structured payload fields carried in the log JSON body.
export type BiddingLogFields = Record<string, unknown>;

// Base structured payload required by every trading bot log entry.
export type BiddingLogMeta = BiddingLogFields & {
    component: BiddingLogComponent | string;
    action: string;
};

// Component-bound logger methods require a stable action for each emission.
export type BiddingComponentLogger = {
    debug(action: string, message: string, fields?: BiddingLogFields): void;
    info(action: string, message: string, fields?: BiddingLogFields): void;
    warn(action: string, message: string, fields?: BiddingLogFields): void;
    error(action: string, message: string, fields?: BiddingLogFields): void;
};

// Converts thrown values into safe, queryable JSON log fields.
export function toErrorLogFields(error: unknown): BiddingLogFields {
    if (error instanceof Error) {
        return {
            errorName: error.name,
            errorMessage: error.message,
        };
    }
    return { errorMessage: String(error) };
}

// Routes bidding-core logs through ArtGod's shared structured process logger.
function emit(level: LogLevel, message: string, meta: BiddingLogMeta): void {
    const isTestRun =
        process.env.VITEST === "true" || process.env.NODE_ENV === "test";
    if (isTestRun && (level === "debug" || level === "info")) {
        return;
    }

    const { component, action, ...fields } = meta;
    const payload = { ...fields, component, action };

    switch (level) {
        case "debug":
            logger.debug(message, payload);
            return;
        case "info":
            logger.info(message, payload);
            return;
        case "warn":
            logger.warn(message, payload);
            return;
        case "error":
            logger.error(message, payload);
            return;
    }
}

export const biddingLog = {
    debug(message: string, meta: BiddingLogMeta): void {
        emit("debug", message, meta);
    },
    info(message: string, meta: BiddingLogMeta): void {
        emit("info", message, meta);
    },
    warn(message: string, meta: BiddingLogMeta): void {
        emit("warn", message, meta);
    },
    error(message: string, meta: BiddingLogMeta): void {
        emit("error", message, meta);
    },
};

// Binds logs to one component while preserving per-call actions and fields.
export function createBiddingComponentLogger(
    component: BiddingLogComponent | string,
): BiddingComponentLogger {
    const withComponent = (
        action: string,
        fields?: BiddingLogFields,
    ): BiddingLogMeta => ({
        ...fields,
        component,
        action,
    });

    return {
        debug(
            action: string,
            message: string,
            fields?: BiddingLogFields,
        ): void {
            emit("debug", message, withComponent(action, fields));
        },
        info(action: string, message: string, fields?: BiddingLogFields): void {
            emit("info", message, withComponent(action, fields));
        },
        warn(action: string, message: string, fields?: BiddingLogFields): void {
            emit("warn", message, withComponent(action, fields));
        },
        error(
            action: string,
            message: string,
            fields?: BiddingLogFields,
        ): void {
            emit("error", message, withComponent(action, fields));
        },
    };
}
