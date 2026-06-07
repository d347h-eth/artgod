// Canonical class name for provider head-lag JSON-RPC failures.
export const RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME =
    "RpcProviderHeadLagError";
export const RPC_PROVIDER_HEAD_LAG_ERROR_MESSAGE =
    "RPC provider head is behind requested block";

// JSON-RPC error codes used for shared provider-error classification.
export const JSON_RPC_ERROR_CODE = {
    InvalidParams: -32602,
} as const;

// Provider error-data messages that indicate endpoint head/indexing lag.
export const RPC_PROVIDER_HEAD_LAG_ERROR_DATA = {
    FromBlockGreaterThanLatestBlock: "from block is greater than latest block",
} as const;

const MAX_RPC_ERROR_CAUSE_SCAN_DEPTH = 6;

// Wraps head-lag failures when adapters need a concrete domain error.
export class RpcProviderHeadLagError extends Error {
    constructor(cause: unknown) {
        super(RPC_PROVIDER_HEAD_LAG_ERROR_MESSAGE);
        this.name = RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME;
        this.cause = cause;
    }
}

// Detects provider head-lag responses hidden inside SDK/provider error chains.
export function isRpcProviderHeadLagError(error: unknown): boolean {
    if (error instanceof RpcProviderHeadLagError) {
        return true;
    }
    for (const candidate of walkRpcErrorChain(error)) {
        if (rpcErrorCode(candidate) !== JSON_RPC_ERROR_CODE.InvalidParams) {
            continue;
        }
        if (rpcErrorDataIndicatesHeadLag(candidate)) {
            return true;
        }
    }
    return false;
}

// Returns the canonical class label for provider-specific RPC conditions.
export function classifiedRpcErrorClassName(
    error: unknown,
): string | undefined {
    if (isRpcProviderHeadLagError(error)) {
        return RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME;
    }
    return undefined;
}

// Head-lag is a transient endpoint freshness condition, not endpoint breakage.
export function shouldPenalizeRpcEndpointFailure(error: unknown): boolean {
    return !isRpcProviderHeadLagError(error);
}

function* walkRpcErrorChain(error: unknown): Generator<unknown> {
    let current = error;
    for (let depth = 0; depth <= MAX_RPC_ERROR_CAUSE_SCAN_DEPTH; depth += 1) {
        if (current === undefined || current === null) {
            return;
        }
        yield current;
        if (typeof current !== "object") {
            return;
        }
        current = (current as { cause?: unknown }).cause;
    }
}

function rpcErrorCode(error: unknown): number | undefined {
    if (!error || typeof error !== "object") {
        return undefined;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === "number" ? code : undefined;
}

function rpcErrorDataIndicatesHeadLag(error: unknown): boolean {
    return rpcErrorTextFields(error).some((value) =>
        value
            .toLowerCase()
            .includes(
                RPC_PROVIDER_HEAD_LAG_ERROR_DATA
                    .FromBlockGreaterThanLatestBlock,
            ),
    );
}

function rpcErrorTextFields(error: unknown): string[] {
    if (!error || typeof error !== "object") {
        return [];
    }
    const record = error as {
        data?: unknown;
        details?: unknown;
        message?: unknown;
    };
    return [record.data, record.details, record.message].filter(
        (value): value is string =>
            typeof value === "string" && value.trim().length > 0,
    );
}
