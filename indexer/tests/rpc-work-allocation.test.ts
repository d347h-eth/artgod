import { describe, expect, it, vi } from "vitest";
import {
    SYNC_WORK_CLASS as CLASS,
    decodeSyncWorkClass,
} from "@artgod/shared/types/sync-work-class";
import { RpcBudgetDeferred } from "@artgod/shared/evm/rpc-budget";
import { gapConsumerName } from "@artgod/shared/queue/nats-job-stream";
import { RpcWorkScope } from "../src/infra/rpc/work-scope.js";
import { bindRpcValidationFactory } from "../src/runtime/rpc-budget.js";
import { FairOrderValidationAdmission } from "../src/infra/orders/fair-validation-admission.js";
import {
    BackfillExecutionGate,
    BACKFILL_EXECUTION_MODE as MODE,
} from "../src/application/backfill-execution.js";
import { runWorker } from "../src/application/worker-runner.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { ORDER_STATUS } from "../src/domain/orders.js";
import type {
    QueuePort,
    QueueMessage,
    SubscribeOptions,
} from "../src/ports/queue.js";

describe("pipeline work allocation", () => {
    it("defaults only legacy work to main and rejects unknown classes", () => {
        expect(decodeSyncWorkClass(undefined)).toBe(CLASS.Main);
        expect(() => decodeSyncWorkClass("backfill")).toThrow();
    });

    it("isolates concurrent job scopes and restores main outside a gap job", async () => {
        const scope = new RpcWorkScope();
        const release = Promise.withResolvers<void>();
        const gap = scope.run(CLASS.GapRepair, async () => {
            await release.promise;
            expect(scope.current()).toBe(CLASS.GapRepair);
        });
        await scope.run(CLASS.Main, async () => {
            expect(scope.current()).toBe(CLASS.Main);
            release.resolve();
            await gap;
            expect(scope.current()).toBe(CLASS.Main);
        });
        expect(scope.current()).toBe(CLASS.Main);
    });

    it("binds deferred snapshot creation, reads and verification after the originating job ended", async () => {
        const scope = new RpcWorkScope();
        const classes: string[] = [];
        const factory = bindRpcValidationFactory(scope, async () => {
            classes.push(scope.current());
            return {
                proof: { observedAt: 1, blockNumber: 1 },
                canAccept: () => true,
                readCounts: () => ({ shared: 0, perOrder: 0, other: 0 }),
                validate: async () => {
                    classes.push(scope.current());
                    return { status: ORDER_STATUS.Fillable, reason: "fixture" };
                },
                finish: async () => {
                    classes.push(scope.current());
                },
            };
        });
        const snapshot = await factory({
            chainId: 1,
            minimumBlock: null,
            workClass: CLASS.GapRepair,
        });
        await snapshot.validate({} as never);
        await snapshot.finish();
        expect(classes).toEqual([
            CLASS.GapRepair,
            CLASS.GapRepair,
            CLASS.GapRepair,
        ]);
        expect(scope.current()).toBe(CLASS.Main);
    });

    it("keeps a validator slot for main and lets main borrow idle background capacity", async () => {
        const admission = new FairOrderValidationAdmission(2);
        const gate = Promise.withResolvers<void>();
        const entered: string[] = [];
        const first = admission.run(
            async () => {
                entered.push("gap-1");
                await gate.promise;
            },
            undefined,
            CLASS.GapRepair,
        );
        const second = admission.run(
            async () => {
                entered.push("gap-2");
            },
            undefined,
            CLASS.GapRepair,
        );
        const main = admission.run(
            async () => {
                entered.push("main");
            },
            undefined,
            CLASS.Main,
        );
        await main;
        expect(entered).toEqual(["gap-1", "main"]);
        gate.resolve();
        await Promise.all([first, second]);
        const both = Promise.withResolvers<void>();
        const main1 = admission.run(async () => {
            entered.push("main-1");
            await both.promise;
        });
        const main2 = admission.run(async () => {
            entered.push("main-2");
            await both.promise;
        });
        expect(entered.slice(-2)).toEqual(["main-1", "main-2"]);
        both.resolve();
        await Promise.all([main1, main2]);
    });

    it("finishes a running gap range then admits manual work ahead of a waiting gap range", async () => {
        const gate = new BackfillExecutionGate();
        const release = Promise.withResolvers<void>();
        const order: string[] = [];
        const first = gate.run(
            MODE.SerializedCurrentState,
            async () => {
                order.push("gap-1");
                await release.promise;
            },
            CLASS.GapRepair,
        );
        const gap = gate.run(
            MODE.SerializedCurrentState,
            async () => {
                order.push("gap-2");
            },
            CLASS.GapRepair,
        );
        const manual = gate.run(MODE.SerializedCurrentState, async () => {
            order.push("manual");
        });
        await Promise.resolve();
        release.resolve();
        await Promise.all([first, gap, manual]);
        expect(order).toEqual(["gap-1", "manual", "gap-2"]);
    });

    it("creates separate durable slots and retains quota deferrals even after many broker deliveries", async () => {
        const subscriptions: Array<{
            options: SubscribeOptions;
            handler: (message: QueueMessage) => Promise<void>;
        }> = [];
        const publish = vi.fn();
        const queue: QueuePort = {
            publish,
            close: async () => {},
            subscribe: async (_queue, handler, options) => {
                subscriptions.push({
                    options,
                    handler: handler as (
                        message: QueueMessage,
                    ) => Promise<void>,
                });
                return async () => {};
            },
        };
        const scope = new RpcWorkScope();
        const handler = vi.fn(async () => {
            expect(scope.current()).toBe(CLASS.GapRepair);
            throw new RpcBudgetDeferred(500);
        });
        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.MetadataDomain,
                consumerName: "fixture-metadata",
                maxInFlight: 2,
                maxAttempts: 5,
                deadLetterQueue: QUEUE_NAMES.DeadLetter,
                acceptGapWork: true,
            },
            handler,
            { workScope: scope },
        );
        expect(
            subscriptions.map((s) => [
                s.options.consumerName,
                s.options.maxInFlight,
            ]),
        ).toEqual([
            ["fixture-metadata", 2],
            [gapConsumerName("fixture-metadata"), 1],
        ]);
        const ack = vi.fn(),
            nack = vi.fn();
        await subscriptions[1]!.handler({
            data: {
                jobId: "fixture",
                kind: "fixture",
                queue: QUEUE_NAMES.MetadataDomain,
                chainId: 1,
                payload: {},
                scheduledAt: 0,
                attempt: 50,
                workClass: CLASS.GapRepair,
            },
            ack,
            nack,
            touch: async () => {},
        });
        expect(nack).toHaveBeenCalledWith({ delayMs: 500 });
        expect(ack).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
        await stop();
    });
});
