import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    ERC721_OWNERSHIP_ABI,
    ERC721_OWNER_OF_FUNCTION,
    ERC721_ABSENT_TOKEN_ERROR,
} from "@artgod/shared/evm/erc721-ownership";
import { encodeErrorResult, encodeFunctionResult } from "viem";
import { ViemRpcProvider } from "../src/infra/rpc/viem.js";
import { RpcRollbackOwnershipSnapshot } from "../src/infra/ownership/rpc-rollback-snapshot.js";
import { RollbackChainRange } from "../src/application/reorg-rollback.js";
import { syncBlockFixture as block } from "./helpers/chain-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";
import {
    emptyOnChainData,
    loadCollection,
    selectBalanceOwners,
    selectTransferCount,
    transferFixture,
} from "./helpers/ownership-fixture.js";

const OWNER = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ORPHAN_OWNER = "0xcccccccccccccccccccccccccccccccccccccccc";
const DIVERGENT_OWNER = "0xdddddddddddddddddddddddddddddddddddddddd";
const CANONICAL = { ...block(103), chainId: 1 };
const ENDPOINTS = [
    "https://a.invalid",
    "https://b.invalid",
    "https://c.invalid",
];

describe("rollback snapshots through the weighted RPC adapter", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() =>
        db.exec(
            "DELETE FROM nft_balances; DELETE FROM nft_transfer_events; DELETE FROM collections; DELETE FROM blocks; DELETE FROM chain_sync_revisions;",
        ),
    );
    afterEach(() => vi.unstubAllGlobals());

    function harness(
        options: {
            divergent?: boolean;
            divergentAbsence?: boolean;
            callError?: { code: number; message: string; data?: string };
        } = {},
    ) {
        const f = transferFixture();
        f.persist([f.transfer(105, 1, OWNER, ORPHAN_OWNER)]);
        const calls: Array<{ endpoint: string; body: any }> = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url, init) => {
                const endpoint = new URL(String(url)).origin;
                const body = JSON.parse(init.body);
                calls.push({ endpoint, body });
                const divergent =
                    options.divergent && endpoint === ENDPOINTS[1];
                const view = divergent ? block(203) : CANONICAL;
                let result: unknown;
                let error: unknown;
                if (body.method === "eth_getBlockByNumber") {
                    result = {
                        number: "0x67",
                        hash: view.hash,
                        parentHash: view.parentHash,
                        timestamp: "0x67",
                        transactions: [],
                    };
                } else if (body.method === "eth_call") {
                    // Every endpoint is coherent with its own branch. A height-only
                    // call would return D; the exact canonical hash is unavailable at B.
                    if (typeof body.params[1] === "string") {
                        if (divergent && options.divergentAbsence)
                            error = {
                                code: 3,
                                message: "execution reverted",
                                data: encodeErrorResult({
                                    abi: ERC721_OWNERSHIP_ABI,
                                    errorName:
                                        ERC721_ABSENT_TOKEN_ERROR.NonexistentToken,
                                    args: [1n],
                                }),
                            };
                        else
                            result = encodeFunctionResult({
                                abi: ERC721_OWNERSHIP_ABI,
                                functionName: ERC721_OWNER_OF_FUNCTION,
                                result: divergent ? DIVERGENT_OWNER : OWNER,
                            });
                    } else if (body.params[1].blockHash !== view.hash) {
                        error = {
                            code: -32001,
                            message: "Requested block not found",
                        };
                    } else if (options.callError) {
                        error = options.callError;
                    } else {
                        result = encodeFunctionResult({
                            abi: ERC721_OWNERSHIP_ABI,
                            functionName: ERC721_OWNER_OF_FUNCTION,
                            result: OWNER,
                        });
                    }
                } else
                    throw new Error(
                        "Unexpected snapshot method: " + body.method,
                    );
                return new Response(
                    JSON.stringify({
                        jsonrpc: "2.0",
                        id: body.id,
                        ...(error ? { error } : { result }),
                    }),
                    { headers: { "Content-Type": "application/json" } },
                );
            }),
        );
        const rpc = new ViemRpcProvider({
            endpoints: ENDPOINTS.map((url) => ({ url, weight: 1 })),
            logChunkSize: 10,
            retryPolicy: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
            resilience: {
                requestTimeoutMs: 1000,
                rateLimiter: { requestsPerSecond: 0, burst: 1 },
                circuitBreaker: {
                    failureThreshold: 10,
                    openMs: 1000,
                    halfOpenMaxRequests: 1,
                },
            },
        });
        return {
            ...f,
            calls,
            rollback: new RollbackChainRange(
                f.storage,
                new RpcRollbackOwnershipSnapshot(rpc),
            ),
        };
    }

    it("retains the exact fork hash when a consistent divergent endpoint cannot serve it", async () => {
        const f = harness({ divergent: true });
        await f.rollback.execute(CANONICAL);
        f.storage.persistSyncResult({
            checkpoint: f.storage.captureSyncCheckpoint(1),
            blocks: [104, 105, 106, 107].map(block),
            data: emptyOnChainData(),
            collections: [loadCollection(1, f.collectionId)],
        });
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: OWNER, amount: "1" },
        ]);
        expect(selectTransferCount(1, f.collectionId, "1")).toBe(0);
        const reads = f.calls.filter((call) => call.body.method === "eth_call");
        expect(reads.map((call) => call.endpoint)).toEqual([
            ENDPOINTS[1],
            ENDPOINTS[2],
        ]);
        for (const { body } of reads)
            expect(body.params[1]).toEqual({
                blockHash: CANONICAL.hash,
                requireCanonical: true,
            });
    });

    it("decodes absence only from an exact canonical block", async () => {
        const f = harness({
            callError: {
                code: 3,
                message: "execution reverted",
                data: encodeErrorResult({
                    abi: ERC721_OWNERSHIP_ABI,
                    errorName: ERC721_ABSENT_TOKEN_ERROR.NonexistentToken,
                    args: [1n],
                }),
            },
        });
        await f.rollback.execute(CANONICAL);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([]);
        expect(
            db
                .prepare(
                    "SELECT owner, block_hash FROM erc721_ownership_checkpoints",
                )
                .get(),
        ).toEqual({ owner: null, block_hash: CANONICAL.hash });
    });

    it("does not use token absence from another fork to erase a canonical owner", async () => {
        const f = harness({ divergent: true, divergentAbsence: true });
        await f.rollback.execute(CANONICAL);
        expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
            { owner: OWNER, amount: "1" },
        ]);
        expect(
            db
                .prepare(
                    "SELECT owner, block_hash FROM erc721_ownership_checkpoints",
                )
                .get(),
        ).toEqual({ owner: OWNER, block_hash: CANONICAL.hash });
    });

    it.each([
        { code: -32602, message: "Unsupported block selector" },
        { code: -32001, message: "Requested block not found" },
        { code: -32000, message: "Requested block is not canonical" },
        { code: 3, message: "execution reverted", data: "0x12345678" },
    ])(
        "leaves all rollback state untouched for $message",
        async (callError) => {
            const f = harness({ callError });
            await expect(f.rollback.execute(CANONICAL)).rejects.toThrow();
            expect(selectBalanceOwners(1, f.collectionId, "1")).toEqual([
                { owner: ORPHAN_OWNER, amount: "1" },
            ]);
            expect(selectTransferCount(1, f.collectionId, "1")).toBe(1);
            expect(f.storage.captureSyncCheckpoint(1).revision).toBe(0);
            expect(
                db
                    .prepare(
                        "SELECT COUNT(*) AS count FROM erc721_ownership_checkpoints",
                    )
                    .get(),
            ).toEqual({ count: 0 });
            for (const { body } of f.calls.filter(
                (call) => call.body.method === "eth_call",
            ))
                expect(body.params[1]).toEqual({
                    blockHash: CANONICAL.hash,
                    requireCanonical: true,
                });
        },
    );
});
