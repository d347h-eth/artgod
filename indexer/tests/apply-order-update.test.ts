import { describe, it, expect, vi } from "vitest";
import { ApplyOrderUpdate } from "../src/application/orders/apply-order-update.js";
import { ORDER_UPDATE_REASON } from "../src/domain/order-jobs.js";
import { ORDER_SOURCE_STATUS } from "../src/domain/orders.js";

function fixture() {
    const lifecycle = { handleOrderUpdateById: vi.fn(async () => {}) };
    return {
        lifecycle,
        worker: new ApplyOrderUpdate({ chainId: 1, lifecycle }),
    };
}
const sale = {
    chainId: 1,
    orderId: "fixture-order",
    source: "opensea",
    reason: ORDER_UPDATE_REASON.SourceExecution,
};

describe("source-independent order update delivery", () => {
    it.each([undefined, null, "malformed", `0x${"12".repeat(32)}`])(
        "retains a sale regardless of optional transaction metadata: %s",
        async (executionTransactionHash) => {
            const { worker, lifecycle } = fixture();
            const payload = { ...sale, executionTransactionHash };
            await worker.execute(payload);
            expect(
                lifecycle.handleOrderUpdateById,
            ).toHaveBeenCalledExactlyOnceWith(payload);
        },
    );
    it("does not acknowledge a delivery whose atomic admission failed", async () => {
        const { worker, lifecycle } = fixture();
        lifecycle.handleOrderUpdateById.mockRejectedValueOnce(
            new Error("fixture writer unavailable"),
        );
        await expect(worker.execute(sale)).rejects.toThrow(
            "writer unavailable",
        );
        await worker.execute(sale);
        expect(lifecycle.handleOrderUpdateById).toHaveBeenCalledTimes(2);
    });
    it("completes independent later updates after a sale admission without receipt work", async () => {
        const { worker, lifecycle } = fixture();
        await worker.execute(sale);
        await worker.execute({
            ...sale,
            orderId: "unrelated",
            reason: ORDER_UPDATE_REASON.Validation,
        });
        expect(
            lifecycle.handleOrderUpdateById.mock.calls.map(
                ([payload]) => payload.orderId,
            ),
        ).toEqual(["fixture-order", "unrelated"]);
    });
    it("shares lifecycle admission for source cancellation and canonical hints", async () => {
        const { worker, lifecycle } = fixture();
        await worker.execute({
            ...sale,
            reason: ORDER_UPDATE_REASON.Cancel,
            sourceStatus: ORDER_SOURCE_STATUS.Cancelled,
        });
        await worker.execute({
            ...sale,
            source: undefined,
            reason: ORDER_UPDATE_REASON.Fill,
            blockNumber: 10,
            blockHash: `0x${"34".repeat(32)}`,
        });
        expect(lifecycle.handleOrderUpdateById).toHaveBeenCalledTimes(2);
    });
    it("rejects invalid routing identity before calling the owner", async () => {
        const { worker, lifecycle } = fixture();
        await expect(worker.execute({ ...sale, chainId: 2 })).rejects.toThrow(
            "identity",
        );
        await expect(
            worker.execute({ ...sale, reason: "unsupported" }),
        ).rejects.toThrow("Unsupported");
        expect(lifecycle.handleOrderUpdateById).not.toHaveBeenCalled();
    });
});
