import { zeroAddress } from "viem";
import { db } from "@artgod/shared/database";
import { computeSeaportOrderHash } from "../../src/application/offchain/seaport-protocol.js";
import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    type OrderRecord,
    type SeaportOrderData,
} from "../../src/domain/orders.js";
import {
    MAKER_TRIGGER_SCOPE,
    type OrderUpdateByMakerPayload,
} from "../../src/domain/order-jobs.js";
import {
    GLOBAL_MAKER_TRIGGER_REASON,
    TOKEN_SCOPED_MAKER_TRIGGER_REASON,
} from "../../src/domain/maker-triggers.js";
import type { RpcBlock, RpcProviderPort } from "../../src/ports/rpc.js";
import type { ConduitRegistryPort } from "../../src/ports/conduits.js";

// Synthetic identities and amounts; the shape mirrors the investigated workload.
export const HEAVY_MAKER = {
    chainId: 1,
    count: 9_339,
    firstCollectionCount: 3_418,
    maker: "0x1111111111111111111111111111111111111111",
    smallMaker: "0x2222222222222222222222222222222222222222",
    seller: "0x3333333333333333333333333333333333333333",
    protocol: "0x0000000000000068f116a894984e2db1123eb395",
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    controller: "0x00000000f9490004c11cef243f5400493c00ad63",
    conduit: "0x4444444444444444444444444444444444444444",
    conduitKey: `0x${"01".repeat(32)}`,
    now: 1_790_208_000,
    blockNumber: 1_000,
} as const;

export function heavyMakerOrder(
    index: number,
    overrides: Partial<OrderRecord> = {},
): OrderRecord {
    const first = index < HEAVY_MAKER.firstCollectionCount;
    const collectionId = first ? 9 : 11;
    const contract =
        overrides.contract ??
        (first
            ? "0x5555555555555555555555555555555555555555"
            : "0x6666666666666666666666666666666666666666");
    const tokenId = overrides.tokenId ?? String(index % (first ? 463 : 327));
    const maker = overrides.maker ?? HEAVY_MAKER.maker;
    const side = overrides.side ?? "buy";
    const price = String(
        1_000_000_000_000_000n + BigInt(index % 124) * 1_000_000_000_000n,
    );
    const data: SeaportOrderData = {
        protocolAddress: HEAVY_MAKER.protocol,
        signature: null,
        offerer: maker,
        zone: zeroAddress,
        offer: [
            {
                itemType: "1",
                token: HEAVY_MAKER.weth,
                identifierOrCriteria: "0",
                startAmount: price,
                endAmount: price,
            },
        ],
        consideration: [
            {
                itemType: "2",
                token: contract,
                identifierOrCriteria: tokenId,
                startAmount: "1",
                endAmount: "1",
                recipient: maker,
            },
        ],
        orderType: "0",
        startTime: String(HEAVY_MAKER.now - 3_600),
        endTime: String(HEAVY_MAKER.now + 86_400),
        zoneHash: `0x${"00".repeat(32)}`,
        salt: String(index + 1),
        conduitKey: HEAVY_MAKER.conduitKey,
        totalOriginalConsiderationItems: "1",
        counter: "0",
    };
    if (side === "sell") {
        const nft = data.consideration[0]!;
        const currency = data.offer[0]!;
        data.offer = [
            {
                itemType: nft.itemType,
                token: nft.token,
                identifierOrCriteria: nft.identifierOrCriteria,
                startAmount: nft.startAmount,
                endAmount: nft.endAmount,
            },
        ];
        data.consideration = [{ ...currency, recipient: maker }];
    }
    return {
        id: computeSeaportOrderHash(data),
        chainId: HEAVY_MAKER.chainId,
        collectionId,
        kind: "seaport",
        side,
        source: "opensea",
        maker,
        contract,
        tokenId,
        price,
        currency: HEAVY_MAKER.weth,
        validFrom: Number(data.startTime),
        validUntil: Number(data.endTime),
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
        sourceStatus: ORDER_SOURCE_STATUS.Active,
        fillabilityStatus: ORDER_STATUS.Fillable,
        seaportData: data,
        seaportDataSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Rest,
        ...overrides,
    };
}

export function heavyMakerHint(
    maker: string = HEAVY_MAKER.maker,
): OrderUpdateByMakerPayload {
    return {
        chainId: HEAVY_MAKER.chainId,
        maker,
        scope: MAKER_TRIGGER_SCOPE.Global,
        reason: GLOBAL_MAKER_TRIGGER_REASON.Erc20Balance,
        blockNumber: HEAVY_MAKER.blockNumber,
    };
}

export function tokenSaleHint(order: OrderRecord): OrderUpdateByMakerPayload {
    return {
        chainId: order.chainId,
        maker: order.maker,
        scope: MAKER_TRIGGER_SCOPE.Token,
        collectionId: order.collectionId,
        tokenId: order.tokenId!,
        reason: TOKEN_SCOPED_MAKER_TRIGGER_REASON.NftTransfer,
        blockNumber: HEAVY_MAKER.blockNumber,
    };
}

/** Seed migrated SQLite in one transaction, constructing only one canonical order at a time. */
export function seedHeavyMaker(count: number = HEAVY_MAKER.count) {
    const small = heavyMakerOrder(count, { maker: HEAVY_MAKER.smallMaker });
    const sale = heavyMakerOrder(count + 1, {
        maker: HEAVY_MAKER.seller,
        side: "sell",
        tokenId: "6762",
    });
    const insert = db.prepare<Record<string, unknown>>(
        "INSERT INTO orders (id,chain_id,collection_id,kind,side,source,maker,contract_address,token_id,price,currency,valid_from,valid_until,source_scope_kind,source_status,fillability_status,seaport_data_json,seaport_data_source_kind,observed_at) " +
            "VALUES (@id,@chainId,@collectionId,@kind,@side,@source,@maker,@contract,@tokenId,@price,@currency,@validFrom,@validUntil,@sourceScopeKind,@sourceStatus,@fillabilityStatus,@seaportDataJson,@seaportDataSourceKind,@observedAt)",
    );
    db.writeTransaction(() => {
        for (const collectionId of [9, 11]) {
            db.prepare(
                "INSERT INTO collections (chain_id,collection_id,slug,address,standard,status,token_scope_kind,bootstrap_anchor_block) VALUES (1,?,?,?,'erc721','live','contract_all_tokens',0)",
            ).run(
                collectionId,
                `heavy-maker-${collectionId}`,
                collectionId === 9
                    ? heavyMakerOrder(0).contract
                    : heavyMakerOrder(HEAVY_MAKER.firstCollectionCount)
                          .contract,
            );
        }
        const save = (order: OrderRecord) =>
            insert.run({
                ...order,
                seaportDataJson: JSON.stringify(order.seaportData),
                observedAt: HEAVY_MAKER.now,
            });
        for (let i = 0; i < count; i++) save(heavyMakerOrder(i));
        save(small);
        save(sale);
    })();
    return { small, sale };
}

export const warmConduits: ConduitRegistryPort = {
    getConduit: () => HEAVY_MAKER.conduit,
    hasChannel: () => true,
    upsertConduit: () => {
        throw new Error("Unexpected cold conduit write");
    },
    replaceChannels: () => {
        throw new Error("Unexpected cold channel write");
    },
};

/** Exact read counts and virtual wire time; no sockets, waits, credentials or live state. */
export class HeavyMakerRpc implements RpcProviderPort {
    readonly reads: Record<string, number> = {};
    virtualMs = 0;
    balance = 10n ** 24n;
    allowance = 10n ** 24n;
    counter = 0n;
    blockNumber: number = HEAVY_MAKER.blockNumber;
    blockHash: `0x${string}` = `0x${"ab".repeat(32)}`;
    onRead?: (
        params: Parameters<RpcProviderPort["readContract"]>[0],
    ) => void | Promise<void>;

    async readContract<T>(
        params: Parameters<RpcProviderPort["readContract"]>[0],
    ): Promise<T> {
        this.reads[params.functionName] =
            (this.reads[params.functionName] ?? 0) + 1;
        this.virtualMs += 10;
        await this.onRead?.(params);
        const values: Record<string, unknown> = {
            getOrderStatus: [false, false, 0n, 1n],
            getCounter: this.counter,
            allowance: this.allowance,
            balanceOf: this.balance,
            ownerOf: HEAVY_MAKER.smallMaker,
            isApprovedForAll: true,
            getConduit: [HEAVY_MAKER.conduit, true],
            getChannels: [HEAVY_MAKER.protocol],
        };
        if (!(params.functionName in values))
            throw new Error(`Unexpected read: ${params.functionName}`);
        return values[params.functionName] as T;
    }
    async getBlockNumber() {
        return this.blockNumber;
    }
    async getBlock(number: number): Promise<RpcBlock> {
        return {
            number,
            hash: this.blockHash,
            parentHash: this.blockHash,
            timestamp: HEAVY_MAKER.now,
            transactions: [],
        };
    }
    async getBalance() {
        return this.balance;
    }
    async getLogs(): Promise<never> {
        throw new Error("Unexpected getLogs");
    }
    async getTransaction(): Promise<never> {
        throw new Error("Unexpected getTransaction");
    }
    async getTransactionReceipt(): Promise<never> {
        throw new Error("Unexpected getTransactionReceipt");
    }
}
