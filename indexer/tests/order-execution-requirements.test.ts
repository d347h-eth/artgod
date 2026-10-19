import {
    beforeAll,
    beforeEach,
    afterEach,
    describe,
    expect,
    it,
    vi,
} from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { SqliteOrdersDomain } from "../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteOrderExecutionRequirements } from "../src/infra/orders/sqlite-order-execution-requirements.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import { ResolveOrderExecutions } from "../src/application/orders/resolve-order-executions.js";
import { ApplyOrderUpdate } from "../src/application/orders/apply-order-update.js";
import { AdmitOrderValidation } from "../src/application/orders/validate-order-demand.js";
import { ORDER_UPDATE_REASON } from "../src/domain/order-jobs.js";
import { ORDER_SOURCE_STATUS } from "../src/domain/orders.js";
import { ORDER_VALIDATION_DEMAND_POLICY as POLICY } from "../src/domain/order-validation-demand.js";
import { advanceChainSyncRevision } from "../src/infra/storage/sqlite-chain-revisions.js";
import {
    HEAVY_MAKER,
    heavyMakerOrder,
    seedHeavyMaker,
} from "./fixtures/heavy-maker.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

const now = HEAVY_MAKER.now * 1000;
const input = {
    chainId: 1,
    orderId: heavyMakerOrder(0).id,
    transactionHash: `0x${"11".repeat(32)}`,
    requiredAt: now,
};
const otherHash = `0x${"22".repeat(32)}`;
const rows = () =>
    db.prepare("SELECT * FROM order_execution_requirements").all();
function workflow() {
    const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
        throw new Error("unused");
    });
    const demand = new SqliteOrderValidationDemand(domain);
    const store = new SqliteOrderExecutionRequirements(demand);
    const resolve = vi.fn(async (_hash: string) => HEAVY_MAKER.blockNumber);
    const processor = new ResolveOrderExecutions({
        chainId: 1,
        store,
        executionBlock: { resolve },
        admission: new FairOrderValidationAdmission(2),
    });
    const apply = new ApplyOrderUpdate({
        chainId: 1,
        executionValidation: store,
        validation: new AdmitOrderValidation(1, demand),
        lifecycle: domain,
    });
    return { domain, demand, store, resolve, processor, apply };
}

describe("durable execution prerequisites", () => {
    loadTestEnv();
    beforeAll(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });
    beforeEach(() => {
        vi.spyOn(Date, "now").mockReturnValue(now);
        db.exec("DELETE FROM orders; DELETE FROM collections;");
        seedHeavyMaker(2);
    });
    afterEach(() => vi.restoreAllMocks());

    it("ACKs durable admission without receipt IO and isolates retries from unrelated by-ID work", async () => {
        const w = workflow();
        w.resolve.mockRejectedValue(new Error("orphaned receipt"));
        const payload = {
            chainId: 1,
            orderId: input.orderId,
            reason: ORDER_UPDATE_REASON.SourceExecutionValidation,
            executionTransactionHash: input.transactionHash,
        };
        await w.apply.execute(payload, now);
        await w.apply.execute(payload, now + 1000);
        expect(rows()).toHaveLength(1);
        expect(w.resolve).not.toHaveBeenCalled();
        await w.processor.executeBatch();
        expect(rows()).toMatchObject([{ failures: 1 }]);
        await w.apply.execute(
            {
                chainId: 1,
                orderId: heavyMakerOrder(1).id,
                reason: ORDER_UPDATE_REASON.Validation,
            },
            now,
        );
        expect(
            w.demand
                .claimBatch(1, "ordinary", now)
                .claims.map((c) => c.demand.orderId),
        ).toEqual([heavyMakerOrder(1).id]);
        expect(await w.processor.executeBatch()).toBeUndefined();
        expect(w.resolve).toHaveBeenCalledTimes(1);
    });

    it("retains two executions independently and resumes a crashed lease without stale completion", async () => {
        const w = workflow();
        await w.store.request(input);
        await w.store.request({ ...input, transactionHash: otherHash });
        const crashed = w.store.claim(1, "crashed", now)!;
        await w.processor.executeBatch();
        expect(w.resolve).toHaveBeenCalledWith(otherHash);
        expect(rows()).toHaveLength(1);
        const restarted = new SqliteOrderExecutionRequirements(w.demand);
        const later = now + POLICY.leaseMs + 1;
        const claim = restarted.claim(1, "restarted", later)!;
        const checkpoint = restarted.captureSyncCheckpoint(1);
        restarted.complete(
            crashed,
            HEAVY_MAKER.blockNumber + 10,
            checkpoint,
            later,
        );
        expect(rows()).toHaveLength(1);
        restarted.complete(
            claim,
            HEAVY_MAKER.blockNumber + 1,
            checkpoint,
            later,
        );
        expect(rows()).toHaveLength(0);
        expect(w.demand.get(1, input.orderId)?.minimumBlock).toBe(
            HEAVY_MAKER.blockNumber + 1,
        );
    });

    it("keeps the requirement when chain revision changes during receipt resolution", async () => {
        const w = workflow();
        await w.store.request(input);
        w.resolve.mockImplementationOnce(async () => {
            advanceChainSyncRevision(1);
            return HEAVY_MAKER.blockNumber;
        });
        await w.processor.executeBatch();
        expect(rows()).toMatchObject([{ failures: 1 }]);
        expect(w.demand.get(1, input.orderId)).toBeNull();
        vi.spyOn(Date, "now").mockReturnValue(now + POLICY.retryBaseMs);
        await w.processor.executeBatch();
        expect(rows()).toHaveLength(0);
        expect(w.demand.get(1, input.orderId)?.pending).toBe(true);
    });

    it.each([false, true])(
        "cancellation settles receipt work without reviving validation (during RPC: %s)",
        async (during) => {
            const w = workflow();
            await w.store.request(input);
            const cancel = () =>
                w.domain.handleOrderUpdateById({
                    chainId: 1,
                    orderId: input.orderId,
                    reason: ORDER_UPDATE_REASON.Cancel,
                    sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
                });
            if (during)
                w.resolve.mockImplementationOnce(async () => {
                    await cancel();
                    return HEAVY_MAKER.blockNumber;
                });
            else await cancel();
            await w.processor.executeBatch();
            expect(rows()).toHaveLength(0);
            expect(w.demand.get(1, input.orderId)).toBeNull();
            expect(w.resolve).toHaveBeenCalledTimes(during ? 1 : 0);
        },
    );

    it("never loses receipt work when demand admission fails", async () => {
        const w = workflow();
        await w.store.request(input);
        vi.spyOn(w.demand, "admit").mockImplementationOnce(() => {
            throw new Error("writer failed");
        });
        await w.processor.executeBatch();
        expect(rows()).toMatchObject([{ failures: 1 }]);
        expect(w.demand.get(1, input.orderId)).toBeNull();
    });
});
