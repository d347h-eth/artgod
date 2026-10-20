import { db } from "@artgod/shared/database";
import { SqliteOrdersDomain } from "../../src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../../src/infra/orders/sqlite-order-validation-demand.js";
import { SqliteMakerRevalidations } from "../../src/infra/orders/sqlite-maker-revalidations.js";
import { FairOrderValidationAdmission } from "../../src/infra/orders/fair-validation-admission.js";
import { RevalidateMakerOrders } from "../../src/application/orders/revalidate-maker.js";
import { ValidateOrderDemand } from "../../src/application/orders/validate-order-demand.js";
import { createSeaportOrderValidationFactory } from "../../src/application/offchain/seaport-validation-batch.js";
import { MAKER_REVALIDATION_STATUS } from "../../src/domain/maker-revalidation.js";
import { ORDER_STATUS } from "../../src/domain/orders.js";
import type { OrderProcessingObservability } from "../../src/application/orders/observability.js";
import { HEAVY_MAKER, HeavyMakerRpc } from "../fixtures/heavy-maker.js";
import { validationChainFixture } from "./validation-chain-fixture.js";

export const makerFixtureOrigin = {
    streamId: "fixture-maker-stream",
    consumerName: "fixture-maker-consumer",
    sequence: 1,
};
export type MakerFixtureInput = Parameters<RevalidateMakerOrders["execute"]>[0];

/** Production expansion, ordinary demand, projection, snapshot and sync owners;
 * only the chain response and the fixture's accepted ownership base are synthetic. */
export function makerValidationWorkflow(
    rpc = new HeavyMakerRpc(),
    observability?: OrderProcessingObservability,
) {
    const orders = new SqliteOrdersDomain(HEAVY_MAKER.weth);
    const demand = new SqliteOrderValidationDemand(orders);
    const store = new SqliteMakerRevalidations(
        orders,
        demand,
        HEAVY_MAKER.weth,
    );
    const processor = new RevalidateMakerOrders({ store, observability });
    const validator = new ValidateOrderDemand({
        chainId: HEAVY_MAKER.chainId,
        store: demand,
        admission: new FairOrderValidationAdmission(2),
        observability,
        createSnapshot: createSeaportOrderValidationFactory({
            chainId: HEAVY_MAKER.chainId,
            rpc,
            conduitController: HEAVY_MAKER.controller,
        }),
    });
    const chain = validationChainFixture({
        chainId: HEAVY_MAKER.chainId,
        rpc,
        collectionIds: [9, 11],
    });
    async function prepare() {
        db.prepare(
            "UPDATE orders SET validation_ready=1,fillability_status=?",
        ).run(ORDER_STATUS.Unvalidated);
        db.prepare("UPDATE collections SET bootstrap_anchor_block=?").run(
            HEAVY_MAKER.blockNumber - 1,
        );
        await chain.apply();
    }
    async function next(input: MakerFixtureInput) {
        const run = store.admit({ ...input, now: Date.now() });
        if (!run || run.status === MAKER_REVALIDATION_STATUS.Completed)
            return run;
        if (run.wakeupOutboxId === null) await processor.execute(input);
        else {
            const row = db
                .prepare("SELECT job_json FROM queue_outbox WHERE outbox_id=?")
                .get(run.wakeupOutboxId) as { job_json: string };
            const job = JSON.parse(row.job_json);
            await processor.resume({
                jobId: job.jobId,
                payload: job.payload,
                queueName: job.queue,
                origin: input.origin,
            });
        }
        return store.get(run.runId)!;
    }
    async function expand(input: MakerFixtureInput) {
        for (let n = 0; n < 1000; n++) {
            const run = await next(input);
            if (!run || run.status === MAKER_REVALIDATION_STATUS.Completed)
                return run;
        }
        throw new Error("Fixture expansion did not complete");
    }
    async function validateReady() {
        let applied = 0;
        let batches = 0;
        while (demand.hasReady(1, Date.now())) {
            if (++batches > 10000)
                throw new Error("Fixture validation did not drain ready work");
            const report = await validator.executeBatch();
            applied += report?.applied ?? 0;
        }
        return { applied, batches };
    }
    return {
        orders,
        demand,
        store,
        processor,
        validator,
        rpc,
        chain,
        prepare,
        next,
        expand,
        validateReady,
    };
}
