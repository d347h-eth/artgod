import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import {
    RPC_BUDGET_POLICY,
    RpcBudgetDeferred,
    rpcEndpointBudgetKey,
} from "@artgod/shared/evm/rpc-budget";
import { SYNC_WORK_CLASS as CLASS } from "@artgod/shared/types/sync-work-class";
import { NatsRpcBudget } from "../src/infra/rpc/nats-budget.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import { runWorker } from "../src/application/worker-runner.js";
import { RpcWorkScope } from "../src/infra/rpc/work-scope.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import {
    IsolatedNats,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";
import { loadReorgRecoveryTestConfig } from "../tests/helpers/reorg-recovery-test-config.js";
import { loadTestEnv } from "../tests/helpers/test-env.js";

describe("shared RPC work allocation through the broker", () => {
    loadTestEnv();
    const { natsBinary } = loadReorgRecoveryTestConfig();
    const endpoint = "http://fixture.invalid";
    const endpointKey = rpcEndpointBudgetKey(endpoint);
    let broker: IsolatedNats;
    let owner: NatsRpcBudget, main: NatsRpcBudget, gap: NatsRpcBudget;
    let queue: NatsJetStreamQueue;
    const stops: Array<() => Promise<void>> = [];
    beforeAll(async () => {
        const parent = resolveProjectPath("tmp/rpc-allocation-nats");
        await mkdir(parent, { recursive: true });
        const artifacts = await mkdtemp(path.join(parent, "run-"));
        broker = await IsolatedNats.start(
            natsBinary,
            artifacts,
            path.join(artifacts, "jetstream"),
        );
        const config = {
            natsUrl: broker.url,
            streamPrefix: "rpc_allocation_fixture",
            chainId: 1,
            endpoints: [{ url: endpoint }],
            endpointLimit: { requestsPerSecond: 6, burst: 1 },
            gap: { requestsPerSecond: 2, maxInFlight: 1 },
            requestTimeoutMs: 100,
        };
        owner = await NatsRpcBudget.connect(config);
        await owner.serve();
        main = await NatsRpcBudget.connect(config);
        gap = await NatsRpcBudget.connect(config);
        queue = await NatsJetStreamQueue.connect(config);
        // Qualify the same restart fence used by production, without overriding it.
        await delay(
            config.requestTimeoutMs + RPC_BUDGET_POLICY.LeaseGraceMs + 20,
        );
    });
    afterAll(async () => {
        main?.stopWaiting();
        gap?.stopWaiting();
        for (const stop of stops) await stop();
        await queue?.close();
        await Promise.all([main?.close(), gap?.close()]);
        await owner?.close();
        await broker?.stop();
    });

    it("shares rate and in-flight limits between independent clients under main load", async () => {
        const times: number[] = [];
        let active = 0,
            peak = 0,
            mainCalls = 0;
        const gaps = Array.from({ length: 4 }, () =>
            gap.run({ endpointKey, workClass: CLASS.GapRepair }, async () => {
                times.push(Date.now());
                peak = Math.max(peak, ++active);
                await delay(40);
                active--;
                return true;
            }),
        );
        const mains = Array.from({ length: 10 }, () =>
            main.run({ endpointKey, workClass: CLASS.Main }, async () => {
                mainCalls++;
            }),
        );
        await Promise.all([...gaps, ...mains]);
        expect(peak).toBe(1);
        expect(mainCalls).toBe(10);
        expect(times).toHaveLength(4);
        expect(
            times.slice(1).every((time, index) => time - times[index]! >= 450),
        ).toBe(true);
    });

    it("releases capacity after a failed request and cancels blocked clients on shutdown", async () => {
        await expect(
            gap.run({ endpointKey, workClass: CLASS.GapRepair }, async () => {
                throw new Error("request failed");
            }),
        ).rejects.toThrow("request failed");
        const held = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        const first = gap.run(
            { endpointKey, workClass: CLASS.GapRepair },
            async () => {
                entered.resolve();
                await held.promise;
            },
        );
        await entered.promise;
        const extra = await NatsRpcBudget.connect({
            natsUrl: broker.url,
            streamPrefix: "rpc_allocation_fixture",
            chainId: 1,
            endpoints: [{ url: endpoint }],
            endpointLimit: { requestsPerSecond: 6, burst: 1 },
            gap: { requestsPerSecond: 2, maxInFlight: 1 },
            requestTimeoutMs: 100,
        });
        let sent = false;
        const waiting = extra.run(
            { endpointKey, workClass: CLASS.GapRepair },
            async () => {
                sent = true;
            },
        );
        const rejected =
            expect(waiting).rejects.toBeInstanceOf(RpcBudgetDeferred);
        await delay(40);
        extra.stopWaiting();
        await rejected;
        held.resolve();
        await first;
        await extra.close();
        expect(sent).toBe(false);
        await main.run({ endpointKey, workClass: CLASS.Main }, async () => {});
    });

    it("lets main use the established limiter when no owner exists and keeps gaps retained", async () => {
        const orphan = await NatsRpcBudget.connect({
            natsUrl: broker.url,
            streamPrefix: "no_owner_fixture",
            chainId: 1,
            endpoints: [{ url: endpoint }],
            endpointLimit: { requestsPerSecond: 6, burst: 1 },
            gap: { requestsPerSecond: 2, maxInFlight: 1 },
            requestTimeoutMs: 100,
        });
        try {
            expect(
                await orphan.run(
                    { endpointKey, workClass: CLASS.Main },
                    async () => "main",
                ),
            ).toBe("main");
            await expect(
                orphan.run(
                    { endpointKey, workClass: CLASS.GapRepair },
                    async () => "gap",
                ),
            ).rejects.toBeInstanceOf(RpcBudgetDeferred);
        } finally {
            await orphan.close();
        }
    });

    it("keeps the logical request waiting across transport deadlines at a low rate", async () => {
        const slowOwner = await NatsRpcBudget.connect({
            natsUrl: broker.url,
            streamPrefix: "slow_allocation_fixture",
            chainId: 1,
            endpoints: [{ url: endpoint }],
            endpointLimit: { requestsPerSecond: 0.01, burst: 1 },
            gap: { requestsPerSecond: 0, maxInFlight: 1 },
            requestTimeoutMs: 100,
        });
        try {
            await slowOwner.serve();
            await slowOwner.run(
                { endpointKey, workClass: CLASS.Main },
                async () => {},
            );
            let sent = false,
                settled = false;
            const waiting = slowOwner.run(
                { endpointKey, workClass: CLASS.Main },
                async () => {
                    sent = true;
                },
            );
            const rejected =
                expect(waiting).rejects.toBeInstanceOf(RpcBudgetDeferred);
            void waiting.then(
                () => {
                    settled = true;
                },
                () => {
                    settled = true;
                },
            );
            await delay(RPC_BUDGET_POLICY.WaitMs + 1500);
            expect(settled).toBe(false);
            expect(sent).toBe(false);
            slowOwner.stopWaiting();
            await rejected;
        } finally {
            await slowOwner.close();
        }
    }, 45_000);

    it("retains paused background requests without consuming main capacity", async () => {
        const pausedOwner = await NatsRpcBudget.connect({
            natsUrl: broker.url,
            streamPrefix: "paused_allocation_fixture",
            chainId: 1,
            endpoints: [{ url: endpoint }],
            endpointLimit: { requestsPerSecond: 6, burst: 1 },
            gap: { requestsPerSecond: 0, maxInFlight: 1 },
            requestTimeoutMs: 100,
        });
        try {
            await pausedOwner.serve();
            let sent = false;
            await expect(
                pausedOwner.run(
                    { endpointKey, workClass: CLASS.GapRepair },
                    async () => {
                        sent = true;
                    },
                ),
            ).rejects.toBeInstanceOf(RpcBudgetDeferred);
            expect(sent).toBe(false);
            await pausedOwner.run(
                { endpointKey, workClass: CLASS.Main },
                async () => {},
            );
        } finally {
            await pausedOwner.close();
        }
    });

    it("delivers main work while a background job occupies its separate durable slot", async () => {
        const scope = new RpcWorkScope();
        const entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
        let mainDone = false,
            gapDone = false;
        stops.push(
            await runWorker(
                queue,
                {
                    queue: QUEUE_NAMES.MetadataRefresh,
                    consumerName: "allocation-metadata",
                    maxInFlight: 1,
                    acceptGapWork: true,
                },
                async (job) => {
                    if (scope.current() === CLASS.GapRepair) {
                        entered.resolve();
                        await release.promise;
                        gapDone = true;
                    } else mainDone = true;
                },
                { workScope: scope },
            ),
        );
        const job = {
            jobId: "allocation-gap",
            kind: "fixture",
            queue: QUEUE_NAMES.MetadataRefresh,
            chainId: 1,
            scheduledAt: 0,
            payload: {},
            workClass: CLASS.GapRepair,
        };
        await queue.publish(job.queue, job);
        await entered.promise;
        await queue.publish(job.queue, {
            ...job,
            jobId: "allocation-main",
            workClass: CLASS.Main,
        });
        await waitForFixture(
            () => mainDone,
            "main queue work alongside blocked gap",
        );
        expect(gapDone).toBe(false);
        release.resolve();
        await waitForFixture(() => gapDone, "background queue completion");
    });
});
