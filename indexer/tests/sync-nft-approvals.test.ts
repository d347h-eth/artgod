import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { ERC1155_ABI, ERC721_ABI } from "../src/abi/index.js";
import { syncRange } from "../src/application/sync.js";
import {
    CollectionRecord,
    type CollectionStandard,
} from "../src/domain/collections.js";
import {
    COLLECTION_SCOPED_MAKER_TRIGGER_REASON,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../src/domain/maker-triggers.js";
import type {
    CollectionScopeRange,
    CollectionScopeResolverPort,
} from "../src/ports/collections.js";
import type {
    RpcBlock,
    RpcLog,
    RpcLogFilter,
    RpcProviderPort,
    RpcTransaction,
    RpcTransactionReceipt,
} from "../src/ports/rpc.js";

const CONTRACT = "0x0000000000000000000000000000000000000abc" as Hex;
const OWNER = "0x00000000000000000000000000000000000000a1" as Hex;
const OPERATOR = "0x00000000000000000000000000000000000000b2" as Hex;
const BLOCK_HASH = `0x${"11".repeat(32)}` as Hex;
const TX_HASH = `0x${"22".repeat(32)}` as Hex;

describe("sync NFT approval triggers", () => {
    it("converts ERC721 token approvals into token-scoped maker triggers", async () => {
        const rpc = new ApprovalLogRpc([
            buildApprovalLog(ERC721_ABI, "Approval", "0x", [
                { type: "address", value: OWNER },
                { type: "address", value: OPERATOR },
                { type: "uint256", value: 7n },
            ]),
        ]);

        const data = await syncRange(
            rpc,
            1,
            [collection({ id: 7 })],
            new TestScopeResolver(),
            { fromBlock: 123, toBlock: 123 },
        );

        expect(data.collectionScoped.nftApprovalEvents).toHaveLength(1);
        expect(data.collectionScoped.makerTriggers).toEqual([
            expect.objectContaining({
                collectionId: 7,
                contract: CONTRACT.toLowerCase(),
                maker: OWNER.toLowerCase(),
                tokenId: "7",
                reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftApproval,
            }),
        ]);
    });

    it("converts ERC721 ApprovalForAll into collection-scoped maker triggers", async () => {
        const rpc = new ApprovalLogRpc([
            buildApprovalLog(
                ERC721_ABI,
                "ApprovalForAll",
                encodeAbiParameters([{ type: "bool" }], [true]),
                [
                    { type: "address", value: OWNER },
                    { type: "address", value: OPERATOR },
                ],
            ),
        ]);

        const data = await syncRange(
            rpc,
            1,
            [collection({ id: 7 }), collection({ id: 8 })],
            new TestScopeResolver(),
            { fromBlock: 123, toBlock: 123 },
        );

        expect(data.collectionScoped.nftApprovalEvents).toHaveLength(2);
        expect(data.collectionScoped.makerTriggers).toEqual([
            expect.objectContaining({
                collectionId: 7,
                contract: CONTRACT.toLowerCase(),
                maker: OWNER.toLowerCase(),
                reason: COLLECTION_SCOPED_MAKER_TRIGGER_REASON.NftApprovalForAll,
            }),
            expect.objectContaining({
                collectionId: 8,
                contract: CONTRACT.toLowerCase(),
                maker: OWNER.toLowerCase(),
                reason: COLLECTION_SCOPED_MAKER_TRIGGER_REASON.NftApprovalForAll,
            }),
        ]);
    });

    it("uses the resolved collection standard for ERC1155 ApprovalForAll logs", async () => {
        const rpc = new ApprovalLogRpc([
            buildApprovalLog(
                ERC1155_ABI,
                "ApprovalForAll",
                encodeAbiParameters([{ type: "bool" }], [true]),
                [
                    { type: "address", value: OWNER },
                    { type: "address", value: OPERATOR },
                ],
            ),
        ]);

        const data = await syncRange(
            rpc,
            1,
            [collection({ id: 7, standard: "erc1155" })],
            new TestScopeResolver(),
            { fromBlock: 123, toBlock: 123 },
        );

        expect(data.collectionScoped.nftApprovalEvents).toEqual([
            expect.objectContaining({
                collectionId: 7,
                contract: CONTRACT.toLowerCase(),
                owner: OWNER.toLowerCase(),
                operator: OPERATOR.toLowerCase(),
                kind: "erc1155",
            }),
        ]);
        expect(data.collectionScoped.makerTriggers).toEqual([
            expect.objectContaining({
                collectionId: 7,
                maker: OWNER.toLowerCase(),
                reason: COLLECTION_SCOPED_MAKER_TRIGGER_REASON.NftApprovalForAll,
            }),
        ]);
    });
});

function buildApprovalLog(
    abi: readonly unknown[],
    eventName: "Approval" | "ApprovalForAll",
    data: Hex,
    indexed: Array<{ type: string; value: unknown }>,
): RpcLog {
    const [topic0] = encodeEventTopics({
        abi,
        eventName,
    }) as [Hex];
    const topics = [
        topic0,
        ...indexed.map(
            (arg) =>
                encodeAbiParameters([{ type: arg.type }], [arg.value]) as Hex,
        ),
    ];
    return {
        address: CONTRACT,
        data,
        topics,
        blockNumber: 123,
        blockHash: BLOCK_HASH,
        transactionHash: TX_HASH,
        logIndex: 3,
    };
}

function collection(input: {
    id: number;
    standard?: CollectionStandard;
}): CollectionRecord {
    return CollectionRecord.fromPersistence({
        chainId: 1,
        id: input.id,
        slug: `collection-${input.id}`,
        address: CONTRACT.toLowerCase(),
        standard: input.standard ?? "erc721",
        status: "live",
        tokenScopeKind: "contract_all_tokens",
        scopeStartTokenId: null,
        scopeTotalSupply: null,
        deploymentBlock: 1,
        bootstrapAnchorBlock: 100,
        bootstrapStartedAt: null,
        bootstrapFinishedAt: null,
        bootstrapLastSyncedBlock: null,
        openseaSlug: null,
        openseaStatus: null,
        openseaReadyAt: null,
        openseaSnapshotStartedAt: null,
        openseaSnapshotCompletedAt: null,
        openseaReconcileStartedAt: null,
        openseaReconcileCompletedAt: null,
        openseaLastStreamEventAt: null,
        openseaLastStreamHealthyAt: null,
        openseaLastError: null,
    });
}

class TestScopeResolver implements CollectionScopeResolverPort {
    resolveTokenScopedCollectionId(
        _chainId: number,
        collections: CollectionRecord[],
        contract: string,
        tokenId: string,
    ): number | null {
        const matches = collections.filter(
            (collection) =>
                collection.address.toLowerCase() === contract.toLowerCase() &&
                collection.containsTokenInScope(tokenId),
        );
        if (matches.length !== 1) return null;
        return matches[0]!.id;
    }

    resolveContractScopedCollectionIds(
        _chainId: number,
        collections: CollectionRecord[],
        contract: string,
    ): number[] {
        return collections
            .filter(
                (collection) =>
                    collection.address.toLowerCase() ===
                    contract.toLowerCase(),
            )
            .map((collection) => collection.id);
    }

    splitRangeByCollectionScope(): CollectionScopeRange[] {
        return [];
    }
}

class ApprovalLogRpc implements RpcProviderPort {
    constructor(private readonly approvalLogs: RpcLog[]) {}

    async getBlockNumber(): Promise<number> {
        return 123;
    }

    async getBlock(blockNumber: number): Promise<RpcBlock> {
        return {
            number: blockNumber,
            hash: BLOCK_HASH,
            parentHash: `0x${"00".repeat(32)}` as Hex,
            timestamp: 1,
            transactions: [],
        };
    }

    async getLogs(filter: RpcLogFilter): Promise<RpcLog[]> {
        const eventNames = new Set(filter.events?.map((event) => event.name));
        if (eventNames.has("Approval") || eventNames.has("ApprovalForAll")) {
            return this.approvalLogs;
        }
        return [];
    }

    async getTransaction(_txHash: string): Promise<RpcTransaction> {
        throw new Error("Approval-only sync should not fetch transactions");
    }

    async getTransactionReceipt(
        _txHash: string,
    ): Promise<RpcTransactionReceipt> {
        throw new Error("Approval-only sync should not fetch receipts");
    }

    async readContract<T = unknown>(): Promise<T> {
        throw new Error("Approval-only sync should not read contracts");
    }

    async getBalance(): Promise<bigint> {
        throw new Error("Approval-only sync should not read balances");
    }
}
