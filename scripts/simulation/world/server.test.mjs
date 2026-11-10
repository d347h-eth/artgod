import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { encodeFunctionData } from "viem";
import { startWorldServer } from "./server.mjs";
import { RPC_RESPONSE_EVENT, RESPONSE_GATE_FUNCTION } from "./contract.mjs";
import { CONTRACT_ABI } from "./wire.mjs";
import {
    completedDisagreementRead,
    PROVIDER_DISAGREEMENT_PHASE as PHASE,
    PROVIDER_READ_OUTCOME as OUTCOME,
} from "../guest/provider-disagreement.mjs";

test(
    "finished HTTP batch receipts retain distinct world identities even with duplicate client IDs",
    { timeout: 5000 },
    async () => {
        const server = await startWorldServer();
        try {
            const response = await fetch(server.rpcUrl, {
                method: "POST",
                body: JSON.stringify([
                    { jsonrpc: "2.0", id: 1, method: "eth_blockNumber" },
                    { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
                ]),
            });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).length, 2);
            const receipts = server.world.trace.filter(
                (e) => e.type === RPC_RESPONSE_EVENT.Finished,
            );
            assert.equal(receipts.length, 2);
            assert.equal(new Set(receipts.map((e) => e.requestIndex)).size, 2);
            for (const receipt of receipts) {
                const request = server.world.trace.find(
                    (e) =>
                        e.type === "request" &&
                        e.requestIndex === receipt.requestIndex,
                );
                const completion = server.world.trace.find(
                    (e) =>
                        e.type === "response" &&
                        e.requestIndex === receipt.requestIndex,
                );
                assert.equal(receipt.method, request.method);
                assert.equal(receipt.provider, request.provider);
                assert.ok(receipt.sequence > completion.sequence);
                assert.equal(receipt.outcome, "response");
            }
        } finally {
            await server.close();
        }
    },
);

test(
    "an actual hash-refusal wire response earns coverage only after HTTP finish",
    { timeout: 5000 },
    async () => {
        const server = await startWorldServer();
        try {
            const world = server.world;
            world.setPhase(PHASE.Armed);
            world.setProviderView("default", { branch: "A", head: 104 });
            const afterSequence = world.trace.at(-1).sequence;
            const rpc = async (method, params) => {
                const response = await fetch(server.rpcUrl, {
                    method: "POST",
                    body: JSON.stringify({
                        jsonrpc: "2.0",
                        id: 1,
                        method,
                        params,
                    }),
                });
                return await response.json();
            };
            const header = await rpc("eth_getBlockByNumber", ["0x68", false]);
            world.setProviderView("default", { branch: "B", head: 104 });
            const result = await rpc("eth_call", [
                {
                    to: world.ledger.addresses.nft,
                    data: encodeFunctionData({
                        abi: CONTRACT_ABI,
                        functionName: "ownerOf",
                        args: [1n],
                    }),
                },
                { blockHash: header.result.hash, requireCanonical: true },
            ]);
            assert.equal(result.error.code, -32001);
            const observed = completedDisagreementRead(world.trace, {
                afterSequence,
                minimumBlock: 104,
            });
            assert.equal(observed.outcome, OUTCOME.HashRefused);
            assert.equal(observed.delivery.type, RPC_RESPONSE_EVENT.Finished);
            assert.equal(observed.header.blockHash, header.result.hash);
        } finally {
            await server.close();
        }
    },
);

test(
    "closing a server with a held reply cannot manufacture a finished-response receipt",
    { timeout: 5000 },
    async () => {
        const server = await startWorldServer();
        let closed = false;
        try {
            const world = server.world;
            const gate = "abort-before-http-finish";
            world.armResponseGate({
                name: gate,
                functionName: RESPONSE_GATE_FUNCTION.Counter,
                argument: world.ledger.addresses.bidder,
            });
            const request = httpRequest(server.rpcUrl, { method: "POST" });
            request.on("error", () => {});
            request.end(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "eth_call",
                    params: [
                        {
                            to: world.ledger.addresses.seaport,
                            data: encodeFunctionData({
                                abi: CONTRACT_ABI,
                                functionName: "getCounter",
                                args: [world.ledger.addresses.bidder],
                            }),
                        },
                        "latest",
                    ],
                }),
            );
            const held = await world.waitForResponseGate(gate);
            assert.equal(held.captures.length, 1);
            const capture = held.captures[0];
            await server.close();
            closed = true;
            request.destroy();
            assert.ok(
                !world.trace.some(
                    (e) =>
                        e.type === RPC_RESPONSE_EVENT.Finished &&
                        e.requestIndex === capture.requestIndex,
                ),
            );
        } finally {
            if (!closed) await server.close();
        }
    },
);
