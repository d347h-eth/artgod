import { describe, expect, it } from "vitest";
import {
    classifiedRpcErrorClassName,
    isRpcDeterministicContractError,
    isRpcProviderHeadLagError,
    JSON_RPC_ERROR_CODE,
    RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAME,
    RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAMES,
    RPC_DETERMINISTIC_CONTRACT_ERROR_TEXT,
    RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME,
    RPC_PROVIDER_HEAD_LAG_ERROR_DATA,
    RpcProviderHeadLagError,
    shouldPenalizeRpcEndpointFailure,
    shouldRetryRpcError,
} from "./rpc-errors.js";

const VIEM_INVALID_PARAMS_ERROR_CLASS = "InvalidParamsRpcError";
const VIEM_RPC_REQUEST_ERROR_CLASS = "RpcRequestError";
const TEST_INVALID_PARAMS_MESSAGE = "invalid params";
const TEST_TIMEOUT_ERROR_CLASS = "TimeoutError";
const TEST_TIMEOUT_MESSAGE = "request timed out";
const TEST_CONTRACT_READ_FAILURE_MESSAGE = "contract read failed";

describe("RPC error classification", () => {
    it("detects viem provider head-lag errors from nested JSON-RPC data", () => {
        const error = buildViemInvalidParamsError(
            RPC_PROVIDER_HEAD_LAG_ERROR_DATA.FromBlockGreaterThanLatestBlock,
        );

        expect(isRpcProviderHeadLagError(error)).toBe(true);
        expect(classifiedRpcErrorClassName(error)).toBe(
            RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME,
        );
        expect(shouldPenalizeRpcEndpointFailure(error)).toBe(false);
        expect(shouldRetryRpcError(error)).toBe(true);
    });

    it("detects plain JSON-RPC head-lag errors from top-level data", () => {
        const error = Object.assign(new Error(TEST_INVALID_PARAMS_MESSAGE), {
            code: JSON_RPC_ERROR_CODE.InvalidParams,
            data: RPC_PROVIDER_HEAD_LAG_ERROR_DATA.FromBlockGreaterThanLatestBlock,
        });

        expect(isRpcProviderHeadLagError(error)).toBe(true);
    });

    it("detects explicit provider head-lag wrapper errors", () => {
        const error = new RpcProviderHeadLagError(
            new Error(TEST_INVALID_PARAMS_MESSAGE),
        );

        expect(isRpcProviderHeadLagError(error)).toBe(true);
        expect(classifiedRpcErrorClassName(error)).toBe(
            RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME,
        );
        expect(shouldPenalizeRpcEndpointFailure(error)).toBe(false);
        expect(shouldRetryRpcError(error)).toBe(true);
    });

    it("does not classify unrelated invalid params as provider head lag", () => {
        const error = buildViemInvalidParamsError("missing address");

        expect(isRpcProviderHeadLagError(error)).toBe(false);
        expect(classifiedRpcErrorClassName(error)).toBeUndefined();
        expect(shouldPenalizeRpcEndpointFailure(error)).toBe(true);
        expect(shouldRetryRpcError(error)).toBe(true);
    });

    it("classifies nested deterministic contract execution failures", () => {
        const error = buildDeterministicContractError();

        expect(isRpcDeterministicContractError(error)).toBe(true);
        expect(classifiedRpcErrorClassName(error)).toBe(
            RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAME,
        );
        expect(shouldPenalizeRpcEndpointFailure(error)).toBe(false);
        expect(shouldRetryRpcError(error)).toBe(false);
    });

    it("classifies provider revert text as deterministic contract failure", () => {
        const error = new Error(
            RPC_DETERMINISTIC_CONTRACT_ERROR_TEXT.ExecutionReverted,
        );

        expect(isRpcDeterministicContractError(error)).toBe(true);
        expect(classifiedRpcErrorClassName(error)).toBe(
            RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAME,
        );
        expect(shouldRetryRpcError(error)).toBe(false);
    });

    it("does not classify transport failures wrapped by contract execution", () => {
        const error = Object.assign(new Error(TEST_TIMEOUT_MESSAGE), {
            name: TEST_TIMEOUT_ERROR_CLASS,
        });

        expect(isRpcDeterministicContractError(error)).toBe(false);
        expect(classifiedRpcErrorClassName(error)).toBeUndefined();
        expect(shouldPenalizeRpcEndpointFailure(error)).toBe(true);
        expect(shouldRetryRpcError(error)).toBe(true);
    });
});

function buildViemInvalidParamsError(data: string): Error {
    const cause = Object.assign(new Error(TEST_INVALID_PARAMS_MESSAGE), {
        name: VIEM_RPC_REQUEST_ERROR_CLASS,
        code: JSON_RPC_ERROR_CODE.InvalidParams,
        data,
    });
    return Object.assign(new Error(TEST_INVALID_PARAMS_MESSAGE), {
        name: VIEM_INVALID_PARAMS_ERROR_CLASS,
        code: JSON_RPC_ERROR_CODE.InvalidParams,
        cause,
    });
}

function buildDeterministicContractError(): Error {
    const cause = Object.assign(
        new Error(RPC_DETERMINISTIC_CONTRACT_ERROR_TEXT.ReturnedNoData),
        {
            name: RPC_DETERMINISTIC_CONTRACT_ERROR_CLASS_NAMES.ContractFunctionZeroData,
        },
    );
    return Object.assign(new Error(TEST_CONTRACT_READ_FAILURE_MESSAGE), {
        cause,
    });
}
