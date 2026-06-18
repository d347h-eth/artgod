// Canonical class name for provider head-lag JSON-RPC failures.
export const RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME = "RpcProviderHeadLagError";
export const RPC_PROVIDER_HEAD_LAG_ERROR_MESSAGE =
    "RPC provider head is behind requested block";

// Canonical class name for deterministic contract execution failures.
export const RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAME =
    "RpcDeterministicContractError";

// Canonical class name for provider zero-data responses to contract calls.
export const RPC_PROVIDER_ZERO_DATA_ERROR_CLASS_NAME =
    "RpcProviderZeroDataError";

// Canonical class name for providers missing historical state for a request.
export const RPC_PROVIDER_STATE_UNAVAILABLE_ERROR_CLASS_NAME =
    "RpcProviderStateUnavailableError";

// JSON-RPC error codes used for shared provider-error classification.
export const JSON_RPC_ERROR_CODE = {
    InvalidParams: -32602,
} as const;

// Provider error-data messages that indicate endpoint head/indexing lag.
export const RPC_PROVIDER_HEAD_LAG_ERROR_DATA = {
    FromBlockGreaterThanLatestBlock: "from block is greater than latest block",
} as const;

// Provider error-data fragments that indicate unavailable historical state.
export const RPC_PROVIDER_STATE_UNAVAILABLE_ERROR_DATA = {
    HistoricalState: "historical state",
    IsNotAvailable: "is not available",
} as const;

// Viem error classes that can represent provider zero-data responses.
export const RPC_PROVIDER_ZERO_DATA_ERROR_CLASS_NAMES = {
    AbiDecodingZeroData: "AbiDecodingZeroDataError",
    ContractFunctionZeroData: "ContractFunctionZeroDataError",
} as const;

// Provider/SDK text fragments that indicate zero-data contract responses.
export const RPC_PROVIDER_ZERO_DATA_ERROR_TEXT = {
    ReturnedNoData: "returned no data",
} as const;

// Viem error classes that mean the contract call result is final for this input.
export const RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAMES = {
    AbiFunctionNotFound: "AbiFunctionNotFoundError",
    ContractFunctionReverted: "ContractFunctionRevertedError",
    ExecutionReverted: "ExecutionRevertedError",
} as const;

// Provider/SDK text fragments that identify final contract execution failures.
export const RPC_DETERMINISTIC_CONTRACT_ERROR_TEXT = {
    ExecutionReverted: "execution reverted",
    FunctionSelectorNotRecognized: "function selector was not recognized",
    MissingRevertData: "missing revert data",
} as const;

const PROVIDER_ZERO_DATA_ERROR_CLASS_NAMES = new Set<string>(
    Object.values(RPC_PROVIDER_ZERO_DATA_ERROR_CLASS_NAMES),
);
const DETERMINISTIC_CONTRACT_ERROR_CLASS_NAMES = new Set<string>(
    Object.values(RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAMES),
);
const MAX_RPC_ERROR_CAUSE_SCAN_DEPTH = 6;
const MAX_RPC_ERROR_TEXT_OBJECT_SCAN_DEPTH = 3;

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

// Detects provider zero-data responses that should be retried on other endpoints.
export function isRpcProviderZeroDataError(error: unknown): boolean {
    for (const candidate of walkRpcErrorChain(error)) {
        if (rpcErrorClassIndicatesProviderZeroData(candidate)) {
            return true;
        }
        if (rpcErrorTextIndicatesProviderZeroData(candidate)) {
            return true;
        }
    }
    return false;
}

// Detects provider responses that cannot serve the requested historical state.
export function isRpcProviderStateUnavailableError(error: unknown): boolean {
    for (const candidate of walkRpcErrorChain(error)) {
        if (rpcErrorTextIndicatesProviderStateUnavailable(candidate)) {
            return true;
        }
    }
    return false;
}

// Detects contract-call failures that retrying another endpoint cannot fix.
export function isRpcDeterministicContractError(error: unknown): boolean {
    for (const candidate of walkRpcErrorChain(error)) {
        if (rpcErrorClassIndicatesDeterministicContract(candidate)) {
            return true;
        }
        if (rpcErrorTextIndicatesDeterministicContract(candidate)) {
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
    if (isRpcProviderStateUnavailableError(error)) {
        return RPC_PROVIDER_STATE_UNAVAILABLE_ERROR_CLASS_NAME;
    }
    if (isRpcProviderZeroDataError(error)) {
        return RPC_PROVIDER_ZERO_DATA_ERROR_CLASS_NAME;
    }
    if (isRpcDeterministicContractError(error)) {
        return RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAME;
    }
    return undefined;
}

// Deterministic contract failures should surface immediately to callers.
export function shouldRetryRpcError(error: unknown): boolean {
    return !isRpcDeterministicContractError(error);
}

// Head-lag and deterministic contract failures are not endpoint breakage.
// Provider zero-data and unavailable-state responses are retried and penalized.
export function shouldPenalizeRpcEndpointFailure(error: unknown): boolean {
    return (
        !isRpcProviderHeadLagError(error) &&
        !isRpcDeterministicContractError(error)
    );
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

function rpcErrorClassIndicatesProviderZeroData(error: unknown): boolean {
    const errorName = rpcErrorClassName(error);
    return (
        errorName !== undefined &&
        PROVIDER_ZERO_DATA_ERROR_CLASS_NAMES.has(errorName)
    );
}

function rpcErrorClassIndicatesDeterministicContract(error: unknown): boolean {
    const errorName = rpcErrorClassName(error);
    return (
        errorName !== undefined &&
        DETERMINISTIC_CONTRACT_ERROR_CLASS_NAMES.has(errorName)
    );
}

function rpcErrorClassName(error: unknown): string | undefined {
    if (!error || typeof error !== "object") {
        return undefined;
    }
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" && name.length > 0 ? name : undefined;
}

function rpcErrorDataIndicatesHeadLag(error: unknown): boolean {
    return rpcErrorTextFields(error).some((value) =>
        value
            .toLowerCase()
            .includes(
                RPC_PROVIDER_HEAD_LAG_ERROR_DATA.FromBlockGreaterThanLatestBlock,
            ),
    );
}

function rpcErrorTextIndicatesProviderStateUnavailable(
    error: unknown,
): boolean {
    return rpcErrorTextFields(error).some((value) => {
        const normalized = value.toLowerCase();
        return (
            normalized.includes(
                RPC_PROVIDER_STATE_UNAVAILABLE_ERROR_DATA.HistoricalState,
            ) &&
            normalized.includes(
                RPC_PROVIDER_STATE_UNAVAILABLE_ERROR_DATA.IsNotAvailable,
            )
        );
    });
}

function rpcErrorTextIndicatesProviderZeroData(error: unknown): boolean {
    return rpcErrorTextFields(error).some((value) => {
        const normalized = value.toLowerCase();
        return Object.values(RPC_PROVIDER_ZERO_DATA_ERROR_TEXT).some(
            (fragment) => normalized.includes(fragment),
        );
    });
}

function rpcErrorTextIndicatesDeterministicContract(error: unknown): boolean {
    return rpcErrorTextFields(error).some((value) => {
        const normalized = value.toLowerCase();
        return Object.values(RPC_DETERMINISTIC_CONTRACT_ERROR_TEXT).some(
            (fragment) => normalized.includes(fragment),
        );
    });
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
    return [record.data, record.details, record.message].flatMap(
        rpcErrorTextValues,
    );
}

function rpcErrorTextValues(value: unknown, depth = 0): string[] {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed.length > 0 ? [trimmed] : [];
    }
    if (
        !value ||
        typeof value !== "object" ||
        depth >= MAX_RPC_ERROR_TEXT_OBJECT_SCAN_DEPTH
    ) {
        return [];
    }
    const record = value as {
        data?: unknown;
        details?: unknown;
        message?: unknown;
    };
    return [record.data, record.details, record.message].flatMap((field) =>
        rpcErrorTextValues(field, depth + 1),
    );
}
