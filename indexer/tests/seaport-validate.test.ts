import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { logger } from "@artgod/shared/utils";
import {
    computeSeaportOrderHash,
    resolveSeaportProtocolVersion,
} from "../src/application/offchain/seaport-protocol.js";
import { validateSeaportOrder } from "../src/application/offchain/seaport-validate.js";
import { normalizeOpenSeaEvent } from "../src/application/offchain/opensea-normalize.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_STATUS,
    type OrderRecord,
    type SeaportOrderData,
} from "../src/domain/orders.js";
import type { ConduitRegistryPort } from "../src/ports/conduits.js";
import type {
    Hex,
    RpcBlock,
    RpcLog,
    RpcLogFilter,
    RpcProviderPort,
    RpcTransaction,
    RpcTransactionReceipt,
} from "../src/ports/rpc.js";
import { resolveFixturePath } from "./helpers/fixture-paths.js";

const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395";
const SEAPORT_CONDUIT = "0x1e0049783f008a0085193e00003d00cd54003c71";
const MAKER = "0xe20bc6122ec3fbfab73b15540495ce1bfc82a601";
const CONTRACT = "0x4e1f41613c9084fdb9e34e11fae9412427480e56";
const ZERO_BYTES32 =
    "0x0000000000000000000000000000000000000000000000000000000000000000";
const ORDER_ID = computeSeaportOrderHash(buildSeaportData());

describe("validateSeaportOrder", () => {
    it("resolves the supported Seaport protocol address to version 1.6", () => {
        expect(resolveSeaportProtocolVersion(SEAPORT)).toBe("1.6");
    });

    it("throws for unsupported Seaport protocol addresses", () => {
        expect(() =>
            resolveSeaportProtocolVersion(
                "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
            ),
        ).toThrow("Unsupported Seaport protocol address");
    });

    it("does not invalidate a REST listing only because signature is missing", async () => {
        const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const rpc = new MockRpc();

        const result = await validateSeaportOrder(
            rpc,
            new MemoryConduitRegistry(),
            {
                conduitController: "0x00000000f9490004c11cef243f5400493c00ad63",
            },
            buildOrderRecord({
                seaportDataSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
            }),
        );

        expect(result).toEqual({
            status: ORDER_STATUS.Fillable,
            reason: "approved",
        });
        expect(warnSpy).not.toHaveBeenCalled();
        expect(rpc.calledFunctions).toEqual([
            "getOrderStatus",
            "getCounter",
            "ownerOf",
            "isApprovedForAll",
        ]);

        warnSpy.mockRestore();
    });

    it("warns when a stream-derived order is missing a signature", async () => {
        const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
        const rpc = new MockRpc();

        const result = await validateSeaportOrder(
            rpc,
            new MemoryConduitRegistry(),
            {
                conduitController: "0x00000000f9490004c11cef243f5400493c00ad63",
            },
            buildOrderRecord({
                seaportDataSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Stream,
            }),
        );

        expect(result).toEqual({
            status: ORDER_STATUS.Fillable,
            reason: "approved",
        });
        expect(warnSpy).toHaveBeenCalledWith(
            "Seaport stream order missing signature",
            expect.objectContaining({
                component: "SeaportOrderValidation",
                orderId: ORDER_ID,
            }),
        );

        warnSpy.mockRestore();
    });

    it("marks the order invalid when the local Seaport hash does not match", async () => {
        const rpc = new MockRpc();

        const result = await validateSeaportOrder(
            rpc,
            new MemoryConduitRegistry(),
            {
                conduitController: "0x00000000f9490004c11cef243f5400493c00ad63",
            },
            buildOrderRecord({
                id: "0x0000000000000000000000000000000000000000000000000000000000000001",
                seaportDataSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
            }),
        );

        expect(result).toEqual({
            status: ORDER_STATUS.Invalid,
            reason: "order-hash-mismatch",
        });
        expect(rpc.calledFunctions).toEqual([]);
    });

    it("verifies a stream order signature with Seaport typed data", async () => {
        const fixture = await readFixture("item_listed.json");
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        const rpc = new MockRpc({
            conduitKey:
                "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
            conduitAddress: SEAPORT_CONDUIT,
            channels: [SEAPORT],
            tokenId: normalized.tokenId ?? undefined,
            maker: normalized.maker,
            contract: normalized.contract,
        });
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1769383500 * 1000);

        const result = await validateSeaportOrder(
            rpc,
            new MemoryConduitRegistry(),
            {
                conduitController: "0x00000000f9490004c11cef243f5400493c00ad63",
            },
            buildOrderRecordFromNormalized(normalized, {
                seaportDataSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Stream,
            }),
        );

        expect(result.status).toBe(ORDER_STATUS.Fillable);
        expect(result.reason).toBe("approved");
        expect(rpc.calledFunctions).toEqual([
            "getOrderStatus",
            "getCounter",
            "getConduit",
            "getChannels",
            "ownerOf",
            "isApprovedForAll",
        ]);

        nowSpy.mockRestore();
    });

    it("invalidates a stream order when the recovered signer does not match maker", async () => {
        const fixture = await readFixture("item_listed.json");
        const normalized = normalizeOpenSeaEvent(fixture);
        expect(normalized).not.toBeNull();
        if (!normalized) return;

        const rpc = new MockRpc();
        const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1769383500 * 1000);
        const result = await validateSeaportOrder(
            rpc,
            new MemoryConduitRegistry(),
            {
                conduitController: "0x00000000f9490004c11cef243f5400493c00ad63",
            },
            buildOrderRecordFromNormalized(normalized, {
                maker: "0x000000000000000000000000000000000000dead",
                seaportDataSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Stream,
            }),
        );

        expect(result).toEqual({
            status: ORDER_STATUS.Invalid,
            reason: "bad-signature",
        });

        nowSpy.mockRestore();
    });

    it("returns invalid instead of throwing when getOrderStatus fails", async () => {
        const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
        const rpc = new MockRpc({
            failFunction: "getOrderStatus",
        });

        const result = await validateSeaportOrder(
            rpc,
            new MemoryConduitRegistry(),
            {
                conduitController: "0x00000000f9490004c11cef243f5400493c00ad63",
            },
            buildOrderRecord({
                seaportDataSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
            }),
        );

        expect(result.status).toBe(ORDER_STATUS.Invalid);
        expect(result.reason).toContain("protocol-error:");
        expect(errorSpy).toHaveBeenCalledWith(
            "Seaport getOrderStatus RPC failed",
            expect.objectContaining({
                component: "SeaportOrderValidation",
                orderId: ORDER_ID,
            }),
        );

        errorSpy.mockRestore();
    });

    it("returns invalid instead of throwing when ownerOf fails", async () => {
        const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
        const rpc = new MockRpc({
            failFunction: "ownerOf",
        });

        const result = await validateSeaportOrder(
            rpc,
            new MemoryConduitRegistry(),
            {
                conduitController: "0x00000000f9490004c11cef243f5400493c00ad63",
            },
            buildOrderRecord({
                seaportDataSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
            }),
        );

        expect(result.status).toBe(ORDER_STATUS.Invalid);
        expect(result.reason).toContain("protocol-error:");
        expect(errorSpy).toHaveBeenCalledWith(
            "Seaport sell order owner lookup failed",
            expect.objectContaining({
                component: "SeaportOrderValidation",
                orderId: ORDER_ID,
            }),
        );

        errorSpy.mockRestore();
    });
});

type MockRpcOptions = {
    failFunction?: string;
    conduitKey?: string;
    conduitAddress?: string;
    channels?: string[];
    maker?: string;
    contract?: string;
    tokenId?: string;
};

class MockRpc implements RpcProviderPort {
    readonly calledFunctions: string[] = [];

    constructor(private readonly options: MockRpcOptions = {}) {}

    async getBlockNumber(): Promise<number> {
        throw new Error("not implemented");
    }

    async getBlock(_blockNumber: number): Promise<RpcBlock> {
        throw new Error("not implemented");
    }

    async getLogs(_filter: RpcLogFilter): Promise<RpcLog[]> {
        throw new Error("not implemented");
    }

    async getTransaction(_txHash: string): Promise<RpcTransaction> {
        throw new Error("not implemented");
    }

    async getTransactionReceipt(
        _txHash: string,
    ): Promise<RpcTransactionReceipt> {
        throw new Error("not implemented");
    }

    async readContract<T = unknown>(params: {
        address: Hex;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
        blockNumber?: number;
    }): Promise<T> {
        this.calledFunctions.push(params.functionName);
        if (this.options.failFunction === params.functionName) {
            throw new Error(`forced failure for ${params.functionName}`);
        }

        switch (params.functionName) {
            case "getOrderStatus":
                return [false, false, 0n, 1n] as T;
            case "getCounter":
                return 0n as T;
            case "getConduit":
                return [
                    this.options.conduitAddress ?? SEAPORT_CONDUIT,
                    true,
                ] as T;
            case "getChannels":
                return (this.options.channels ?? [SEAPORT]) as T;
            case "ownerOf":
                return (this.options.maker ?? MAKER) as T;
            case "isApprovedForAll":
                return true as T;
            case "getApproved":
                return (this.options.conduitAddress ?? SEAPORT) as T;
            case "allowance":
                return (10n ** 19n) as T;
            case "balanceOf":
                return (10n ** 19n) as T;
            default:
                throw new Error(
                    `Unexpected readContract call: ${params.functionName}`,
                );
        }
    }

    async getBalance(_address: Hex): Promise<bigint> {
        if (this.options.failFunction === "getBalance") {
            throw new Error("forced failure for getBalance");
        }
        return 10n ** 19n;
    }
}

class MemoryConduitRegistry implements ConduitRegistryPort {
    private readonly conduits = new Map<string, string>();
    private readonly channels = new Set<string>();

    getConduit(chainId: number, conduitKey: string): string | null {
        return (
            this.conduits.get(`${chainId}:${conduitKey.toLowerCase()}`) ?? null
        );
    }

    upsertConduit(params: {
        chainId: number;
        conduitKey: string;
        conduitAddress: string;
    }): void {
        this.conduits.set(
            `${params.chainId}:${params.conduitKey.toLowerCase()}`,
            params.conduitAddress.toLowerCase(),
        );
    }

    hasChannel(
        chainId: number,
        conduitAddress: string,
        channelAddress: string,
    ): boolean {
        return this.channels.has(
            `${chainId}:${conduitAddress.toLowerCase()}:${channelAddress.toLowerCase()}`,
        );
    }

    replaceChannels(
        chainId: number,
        conduitAddress: string,
        channels: string[],
    ): void {
        for (const channel of channels) {
            this.channels.add(
                `${chainId}:${conduitAddress.toLowerCase()}:${channel.toLowerCase()}`,
            );
        }
    }
}

function buildOrderRecord(overrides: Partial<OrderRecord> = {}): OrderRecord {
    return {
        id: overrides.id ?? ORDER_ID,
        chainId: overrides.chainId ?? 1,
        kind: "seaport",
        side: overrides.side ?? "sell",
        source: "opensea",
        maker: overrides.maker ?? MAKER,
        taker: overrides.taker ?? null,
        contract: overrides.contract ?? CONTRACT,
        tokenId: overrides.tokenId ?? "7710",
        tokenSetId: overrides.tokenSetId ?? null,
        tokenSetSchemaHash: overrides.tokenSetSchemaHash ?? null,
        price: overrides.price ?? "276500000000000000",
        currency:
            overrides.currency ?? "0x0000000000000000000000000000000000000000",
        validFrom: overrides.validFrom ?? 1772850621,
        validUntil: overrides.validUntil ?? 1775442621,
        fillabilityStatus: overrides.fillabilityStatus ?? ORDER_STATUS.Fillable,
        sourceStatus: overrides.sourceStatus ?? "active",
        seaportData: overrides.seaportData ?? buildSeaportData(),
        seaportDataSourceKind:
            overrides.seaportDataSourceKind ??
            ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
        blockNumber: overrides.blockNumber ?? null,
        txHash: overrides.txHash ?? null,
        logIndex: overrides.logIndex ?? null,
    };
}

function buildOrderRecordFromNormalized(
    normalized: NonNullable<ReturnType<typeof normalizeOpenSeaEvent>>,
    overrides: Partial<OrderRecord> = {},
): OrderRecord {
    return {
        ...buildOrderRecord({
            id: normalized.orderId,
            side: normalized.side,
            maker: normalized.maker,
            taker: normalized.taker ?? null,
            contract: normalized.contract,
            tokenId: normalized.tokenId ?? null,
            price: normalized.price ?? null,
            currency: normalized.currency ?? null,
            validFrom: normalized.validFrom ?? null,
            validUntil: normalized.validUntil ?? null,
            seaportData: normalized.seaportData ?? null,
        }),
        ...overrides,
    };
}

function buildSeaportData(): SeaportOrderData {
    return {
        protocolAddress: SEAPORT,
        signature: null,
        offerer: MAKER,
        zone: "0x0000000000000000000000000000000000000000",
        offer: [
            {
                itemType: "2",
                token: CONTRACT,
                identifierOrCriteria: "7710",
                startAmount: "1",
                endAmount: "1",
            },
        ],
        consideration: [
            {
                itemType: "0",
                token: "0x0000000000000000000000000000000000000000",
                identifierOrCriteria: "0",
                startAmount: "273735000000000000",
                endAmount: "273735000000000000",
                recipient: MAKER,
            },
            {
                itemType: "0",
                token: "0x0000000000000000000000000000000000000000",
                identifierOrCriteria: "0",
                startAmount: "2765000000000000",
                endAmount: "2765000000000000",
                recipient: "0x0000a26b00c1f0df003000390027140000faa719",
            },
        ],
        startTime: "1772850621",
        endTime: "1775442621",
        orderType: "0",
        zoneHash: ZERO_BYTES32,
        salt: "70164244328926012465918583528159937063507298733090730315624638188190333160040",
        conduitKey: ZERO_BYTES32,
        totalOriginalConsiderationItems: "2",
        counter: "0",
    };
}

async function readFixture(name: string): Promise<{
    event_type: string;
    payload: Record<string, unknown>;
}> {
    const filePath = resolveFixturePath(
        import.meta.url,
        "opensea-event-payloads",
        name,
    );
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as {
        event_type: string;
        payload: Record<string, unknown>;
    };
}
