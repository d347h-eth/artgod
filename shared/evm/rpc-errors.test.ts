import { describe, expect, it } from "vitest";
import {
    classifiedRpcErrorClassName,
    isRpcProviderHeadLagError,
    JSON_RPC_ERROR_CODE,
    RPC_PROVIDER_HEAD_LAG_ERROR_CLASS_NAME,
    RPC_PROVIDER_HEAD_LAG_ERROR_DATA,
    RpcProviderHeadLagError,
    shouldPenalizeRpcEndpointFailure,
} from "./rpc-errors.js";

const VIEM_INVALID_PARAMS_ERROR_CLASS = "InvalidParamsRpcError";
const VIEM_RPC_REQUEST_ERROR_CLASS = "RpcRequestError";
const TEST_INVALID_PARAMS_MESSAGE = "invalid params";

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
    });

    it("detects plain JSON-RPC head-lag errors from top-level data", () => {
        const error = Object.assign(new Error(TEST_INVALID_PARAMS_MESSAGE), {
            code: JSON_RPC_ERROR_CODE.InvalidParams,
            data: RPC_PROVIDER_HEAD_LAG_ERROR_DATA
                .FromBlockGreaterThanLatestBlock,
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
    });

    it("does not classify unrelated invalid params as provider head lag", () => {
        const error = buildViemInvalidParamsError("missing address");

        expect(isRpcProviderHeadLagError(error)).toBe(false);
        expect(classifiedRpcErrorClassName(error)).toBeUndefined();
        expect(shouldPenalizeRpcEndpointFailure(error)).toBe(true);
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
