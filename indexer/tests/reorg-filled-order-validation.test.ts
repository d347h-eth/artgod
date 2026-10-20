import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
    encodeAbiParameters,
    encodeEventTopics,
    zeroAddress,
    type Hex,
} from "viem";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { usableOrderEvidenceSql } from "@artgod/shared/database/order-evidence";
import { SEAPORT_ITEM_TYPE } from "@artgod/shared/market-data/seaport";
import { MARKET_DATA_STORAGE_POLICY } from "@artgod/shared/market-data/storage-policy";
import { ERC721_ABI, ERC721_EVENT_NAME } from "../src/abi/index.js";
import { SEAPORT_ORDER_FULFILLED_ABI } from "../src/application/fills/seaport.js";
import { ValidateOrderDemand } from "../src/application/orders/validate-order-demand.js";
import { createSeaportOrderValidationFactory } from "../src/application/offchain/seaport-validation-batch.js";
import { ORDER_STATUS } from "../src/domain/orders.js";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { SqliteMarketDataMaintenance } from "../src/infra/storage/sqlite-market-data-maintenance.js";
import type {
    RpcLog,
    RpcLogFilter,
    RpcProviderPort,
} from "../src/ports/rpc.js";
import { createAppliedSyncFixture } from "./helpers/applied-sync-fixture.js";
import {
    insertCollection,
    loadCollection,
    selectBalanceOwners,
} from "./helpers/ownership-fixture.js";
import { syncBlockFixture } from "./helpers/chain-fixture.js";
import {
    REORG_FIXTURE as F,
    RecoveryRpc,
    reorgRecoveryServices,
} from "./helpers/reorg-recovery-fixture.js";
import {
    HEAVY_MAKER as H,
    HeavyMakerRpc,
    heavyMakerOrder,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

/** Only RPC answers are controlled. Sync decodes the transfer and fulfillment
 * receipt, applies the canonical fill, and owns rollback/resync. Ordinary demand
 * runs the full Seaport validator before and after that actual recovery. */
class FilledOrderRpc extends RecoveryRpc {
    head: number = F.Fork;
    replaced = false;
    readonly stateReads = new HeavyMakerRpc();
    readonly statusBlocks: Array<{ blockNumber: number; blockHash: string }> =
        [];

    override async getBlockNumber() {
        return this.head;
    }

    override async getBlock(number: number) {
        const hash = (n: number) =>
            syncBlockFixture(this.replaced && n > F.Fork ? n + 10_000 : n).hash;
        return {
            ...syncBlockFixture(number),
            hash: hash(number),
            parentHash: hash(number - 1),
            timestamp: H.now + number,
        };
    }

    override async getLogs(filter: RpcLogFilter) {
        return this.replaced ? [] : super.getLogs(filter);
    }

    override async readContractAtBlock<T>(
        input: Parameters<RpcProviderPort["readContractAtBlock"]>[0],
    ): Promise<T> {
        const current = await this.getBlock(input.block.blockNumber);
        if (input.block.blockHash !== current.hash)
            throw new Error("Requested block is no longer canonical");
        if (input.functionName === "getOrderStatus") {
            this.statusBlocks.push({ ...input.block });
            return [
                true,
                false,
                !this.replaced && input.block.blockNumber >= F.Orphan ? 1n : 0n,
                1n,
            ] as T;
        }
        if (input.functionName === "ownerOf") return H.seller as T;
        return this.stateReads.readContractAtBlock<T>(input);
    }

    async getBalanceAtBlock(
        address: Hex,
        block: Parameters<RpcProviderPort["getBalanceAtBlock"]>[1],
    ) {
        if ((await this.getBlock(block.blockNumber)).hash !== block.blockHash)
            throw new Error("Requested block is no longer canonical");
        return this.stateReads.getBalanceAtBlock(address, block);
    }
}

loadTestEnv();
beforeEach(async () => {
    vi.spyOn(Date, "now").mockReturnValue(H.now * 1_000);
    setDbPath(await createTempDbPath());
    await createMigrationRunner().runMigrations();
});
afterEach(() => vi.restoreAllMocks());

it("reopens one executable unit after a decoded fill, terminal proof, maintenance and coordinator reorg", async () => {
    const rpc = new FilledOrderRpc();
    const declaration = heavyMakerOrder(0);
    const collectionId = insertCollection({
        chainId: H.chainId,
        slug: "filled-order-recovery",
        address: declaration.contract,
        anchorBlock: F.Anchor,
    });
    createAppliedSyncFixture({
        chainId: H.chainId,
        anchor: await rpc.getBlock(F.Anchor),
        collections: [loadCollection(H.chainId, collectionId)],
    });
    let services = reorgRecoveryServices(rpc, { gapWorkEnabled: false });
    const orders = new SqliteOrdersDomain(H.weth);
    const demand = new SqliteOrderValidationDemand(orders);
    const validate = new ValidateOrderDemand({
        chainId: H.chainId,
        store: demand,
        admission: new FairOrderValidationAdmission(2),
        createSnapshot: createSeaportOrderValidationFactory({
            chainId: H.chainId,
            rpc,
            conduitController: H.controller,
        }),
    });
    const row = () =>
        db
            .prepare(
                "SELECT fillability_status,quantity,fillable_quantity,proof_block_hash,proof_chain_revision FROM orders WHERE id=?",
            )
            .get(declaration.id);
    const usable = () =>
        !!db
            .prepare(
                `SELECT 1 FROM orders o WHERE o.id=? AND ${usableOrderEvidenceSql({ orderAlias: "o", nowMs: "?" })}`,
            )
            .get(declaration.id, Date.now());
    async function sampleAndDrain() {
        const request = services.progress.captureHeadSample(H.chainId);
        services.progress.recordHeadSample(
            request,
            await rpc.getBlock(rpc.head),
            Date.now(),
        );
        for (let pass = 0; pass < 30; pass++)
            if (!(await services.executor.runDue())) return;
        throw new Error("Coordinator failed to settle");
    }
    await orders.handleOrderUpsert({
        ...declaration,
        orderId: declaration.id,
        collectionId,
        rawSourceKind: declaration.seaportDataSourceKind!,
        observedAt: H.now,
    });
    await sampleAndDrain();
    expect((await validate.executeBatch())?.applied).toBe(1);
    expect(row()).toMatchObject({
        fillability_status: ORDER_STATUS.Fillable,
        quantity: "1",
        fillable_quantity: "1",
    });
    expect(usable()).toBe(true);

    const transactionHash = H.saleTransactionHash;
    const attribution = {
        transactionHash,
        blockNumber: F.Orphan,
        blockHash: (await rpc.getBlock(F.Orphan)).hash,
    };
    const transfer: RpcLog = {
        ...attribution,
        address: declaration.contract as Hex,
        data: "0x",
        topics: encodeEventTopics({
            abi: ERC721_ABI,
            eventName: ERC721_EVENT_NAME.Transfer,
            args: {
                from: H.seller,
                to: H.maker,
                tokenId: BigInt(declaration.tokenId!),
            },
        }) as Hex[],
        logIndex: 0,
    };
    const fulfillment: RpcLog = {
        ...attribution,
        address: H.protocol,
        topics: encodeEventTopics({
            abi: SEAPORT_ORDER_FULFILLED_ABI,
            eventName: "OrderFulfilled",
            args: { offerer: H.maker, zone: zeroAddress },
        }) as Hex[],
        data: encodeAbiParameters(
            SEAPORT_ORDER_FULFILLED_ABI[0].inputs.filter(
                (input) => !input.indexed,
            ),
            [
                declaration.id as Hex,
                H.seller,
                [
                    {
                        itemType: SEAPORT_ITEM_TYPE.Erc20,
                        token: H.weth,
                        identifier: 0n,
                        amount: BigInt(declaration.price!),
                    },
                ],
                [
                    {
                        itemType: SEAPORT_ITEM_TYPE.Erc721,
                        token: declaration.contract as Hex,
                        identifier: BigInt(declaration.tokenId!),
                        amount: 1n,
                        recipient: H.maker,
                    },
                ],
            ],
        ),
        logIndex: 1,
    };
    rpc.logs = [transfer, fulfillment];
    rpc.transactions.set(transactionHash, {
        hash: transactionHash,
        from: H.seller,
        to: H.protocol,
        input: "0x",
    });
    rpc.receipts.set(transactionHash, {
        ...attribution,
        logs: [transfer, fulfillment],
    });
    rpc.head = F.Orphan;
    await sampleAndDrain();
    expect(db.prepare("SELECT order_id FROM fills").all()).toEqual([
        { order_id: declaration.id },
    ]);
    expect(demand.get(H.chainId, declaration.id)?.pending).toBe(true);
    expect(usable()).toBe(false);
    expect((await validate.executeBatch())?.applied).toBe(1);
    expect(row()).toMatchObject({
        fillability_status: ORDER_STATUS.Filled,
        quantity: "0",
        fillable_quantity: "0",
        proof_block_hash: attribution.blockHash,
        proof_chain_revision: 0,
    });
    const afterGrace =
        H.now + MARKET_DATA_STORAGE_POLICY.orderReorgGraceSeconds + 1;
    // SQLite's CURRENT_TIMESTAMP is independent of the controlled JS clock.
    // Age only this observation time so maintenance reaches its terminal rule.
    db.prepare(
        "UPDATE orders SET updated_at=datetime(?,'unixepoch') WHERE id=?",
    ).run(H.now, declaration.id);
    new SqliteMarketDataMaintenance(db).maintainBatch(afterGrace);
    expect(row()).toMatchObject({ fillability_status: ORDER_STATUS.Filled });

    rpc.replaced = true;
    services.checks.retain(
        {
            chainId: H.chainId,
            checkpoint: services.storage.captureSyncCheckpoint(H.chainId),
            blockNumber: F.Orphan,
            blockHash: attribution.blockHash,
        },
        { disputed: true },
    );
    expect(usable()).toBe(false);
    await services.recovery.checkDue();
    expect(row()).toMatchObject({
        fillability_status: ORDER_STATUS.Unvalidated,
        fillable_quantity: null,
        proof_block_hash: null,
    });
    expect(demand.get(H.chainId, declaration.id)?.pending).toBe(true);
    expect(db.prepare("SELECT order_id FROM fills").all()).toEqual([]);
    expect(
        selectBalanceOwners(H.chainId, collectionId, declaration.tokenId!),
    ).toEqual([{ owner: H.seller, amount: "1" }]);
    expect(await validate.executeBatch()).toBeUndefined();

    // Reconstructed production owners resume retained acquisition, then the
    // same ordinary validator obtains a fresh exact replacement-block result.
    services = reorgRecoveryServices(rpc, { gapWorkEnabled: false });
    await sampleAndDrain();
    expect((await validate.executeBatch())?.applied).toBe(1);
    const replacement = await rpc.getBlock(F.Orphan);
    expect(row()).toMatchObject({
        fillability_status: ORDER_STATUS.Fillable,
        quantity: "1",
        fillable_quantity: "1",
        proof_block_hash: replacement.hash,
        proof_chain_revision: 1,
    });
    expect(usable()).toBe(true);
    expect(rpc.statusBlocks).toEqual([
        expect.objectContaining({ blockNumber: F.Fork }),
        expect.objectContaining({
            blockNumber: F.Orphan,
            blockHash: attribution.blockHash,
        }),
        expect.objectContaining({
            blockNumber: F.Orphan,
            blockHash: replacement.hash,
        }),
    ]);
});
