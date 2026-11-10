import assert from "node:assert/strict";
import test from "node:test";
import { createPublicClient, custom, encodeFunctionData } from "viem";
import {
    CONTRACT_ABI,
    decodeRpcContractCalls,
    encodeDeploylessMulticallResult,
    encodeResult,
} from "./wire.mjs";
import { RESPONSE_GATE_FUNCTION } from "./contract.mjs";

const target = "0x1111111111111111111111111111111111111111";
const maker = "0x2222222222222222222222222222222222222222";
const data = encodeFunctionData({
    abi: CONTRACT_ABI,
    functionName: RESPONSE_GATE_FUNCTION.Counter,
    args: [maker],
});

test("RPC contract call decoding preserves the actual scalar target, function and arguments", () => {
    for (const field of ["data", "input"])
        assert.deepEqual(
            decodeRpcContractCalls({
                method: "eth_call",
                params: [{ to: target, [field]: data }, "0x69"],
            }),
            [
                {
                    target,
                    functionName: RESPONSE_GATE_FUNCTION.Counter,
                    args: [maker],
                },
            ],
        );
});

test("the installed viem deployless encoding decodes into ordered contract leaves", async () => {
    let captured;
    const client = createPublicClient({
        transport: custom({
            request: async (request) => {
                captured = request;
                return encodeDeploylessMulticallResult([
                    {
                        success: true,
                        returnData: encodeResult("ownerOf", maker),
                    },
                    {
                        success: true,
                        returnData: encodeResult(
                            RESPONSE_GATE_FUNCTION.Counter,
                            1n,
                        ),
                    },
                ]);
            },
        }),
    });
    await client.multicall({
        contracts: [
            {
                address: target,
                abi: CONTRACT_ABI,
                functionName: "ownerOf",
                args: [1n],
            },
            {
                address: maker,
                abi: CONTRACT_ABI,
                functionName: RESPONSE_GATE_FUNCTION.Counter,
                args: [target],
            },
        ],
        blockNumber: 105n,
        deployless: true,
        batchSize: 0,
        allowFailure: true,
    });
    assert.equal(captured.params[0].to, undefined);
    assert.deepEqual(decodeRpcContractCalls(captured), [
        { target, functionName: "ownerOf", args: [1n] },
        {
            target: maker,
            functionName: RESPONSE_GATE_FUNCTION.Counter,
            args: [target],
        },
    ]);
});

test("non-call, missing transaction and unsupported calldata cannot become contract identity", () => {
    for (const request of [
        undefined,
        { method: "eth_getBlockByNumber", params: ["0x69", false] },
        { method: "eth_call" },
        { method: "eth_call", params: { 0: { to: target, data } } },
        { method: "eth_call", params: [null] },
        { method: "eth_call", params: [[]] },
        { method: "eth_call", params: [{ to: target, data: "0x12345678" }] },
        { method: "eth_call", params: [{ data: "0x00" }] },
    ])
        assert.throws(() => decodeRpcContractCalls(request));
});
