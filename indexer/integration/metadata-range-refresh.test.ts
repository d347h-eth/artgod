import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { resolveProjectPath } from "@artgod/shared/utils/paths";
import { runWorker } from "../src/application/worker-runner.js";
import { drainQueueOutbox } from "../src/application/queue-outbox/drainer.js";
import { NatsJetStreamQueue } from "../src/infra/queue/nats.js";
import {
    DOMAIN_JOB_KIND,
    type MetadataRefreshRangePayload,
} from "../src/domain/domain-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import { QUEUE_OUTBOX_RETRY_POLICY } from "../src/domain/queue-outbox.js";
import type { QueuePort } from "../src/ports/queue.js";
import {
    IsolatedNats,
    waitForFixture,
} from "../tests/helpers/isolated-nats.js";
import { loadReorgRecoveryTestConfig } from "../tests/helpers/reorg-recovery-test-config.js";
import { metadataRangeFixture } from "../tests/helpers/metadata-range-fixture.js";
import { createTempDbPath } from "../tests/helpers/test-helpers.js";
import { loadTestEnv } from "../tests/helpers/test-env.js";

describe("isolated broker metadata range continuations", () => {
    loadTestEnv();
    const { natsBinary } = loadReorgRecoveryTestConfig();
    let broker: IsolatedNats | undefined;
    let queue: NatsJetStreamQueue;
    let stop: (() => Promise<void>) | undefined;
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
        const parent = resolveProjectPath("tmp/metadata-range-nats");
        await mkdir(parent, { recursive: true });
        const artifacts = await mkdtemp(path.join(parent, "run-"));
        broker = await IsolatedNats.start(
            natsBinary,
            artifacts,
            path.join(artifacts, "jetstream"),
        );
        queue = await NatsJetStreamQueue.connect({
            natsUrl: broker.url,
            streamPrefix: "metadata_range_fixture",
        });
    });
    afterEach(async () => {
        await stop?.();
        stop = undefined;
        await queue?.close();
        await broker?.stop();
        broker = undefined;
    });

    it("ACKs a queued orphan tail before a barrier without any additional token URI reads", async () => {
        const published: JobEnvelope[] = [];
        const publisher: Pick<QueuePort, "publish"> = {
            publish: async (target, job) => {
                published.push(job);
                return queue.publish(target, job);
            },
        };
        const f = metadataRangeFixture({ queue: publisher, tokenCount: 4 });
        await f.handler(f.root);
        const tail = published[0];
        f.rollback();
        const admitted: string[] = [];
        stop = await runWorker<MetadataRefreshRangePayload>(
            queue,
            {
                queue: QUEUE_NAMES.MetadataRefresh,
                consumerName: "metadata-range-orphan",
                maxInFlight: 1,
            },
            async (job) => {
                await f.handler(job);
                admitted.push(job.jobId);
            },
            { admission: f.admission },
        );
        const barrier: JobEnvelope<MetadataRefreshRangePayload> = {
            ...f.root,
            jobId: "metadata-range-barrier",
            onchainBlock: undefined,
            payload: { ...f.root.payload, cursorTokenId: "5" },
        };
        await queue.publish(QUEUE_NAMES.MetadataRefresh, barrier);
        await waitForFixture(
            () => admitted.includes(barrier.jobId),
            "orphan tail ACK before barrier",
        );
        expect(admitted).toEqual([barrier.jobId]);
        expect(f.admission.isCurrent(tail)).toBe(false);
        expect(f.uriReads.map((read) => read.tokenId)).toEqual(["1", "2"]);
    });

    it("refreshes every replacement token after an old root and tail were ACKed inside the dedupe window", async () => {
        const f = metadataRangeFixture({ queue, tokenCount: 4 });
        const delivered: JobEnvelope<MetadataRefreshRangePayload>[] = [];
        const start = async () =>
            runWorker<MetadataRefreshRangePayload>(
                queue,
                {
                    queue: QUEUE_NAMES.MetadataRefresh,
                    consumerName: "metadata-range-replacement",
                    maxInFlight: 1,
                },
                async (job) => {
                    await f.handler(job);
                    delivered.push(job);
                },
                { admission: f.admission },
            );
        stop = await start();
        await drainQueueOutbox(f.outbox, queue);
        await waitForFixture(
            () => delivered.length === 2,
            "old metadata root and tail",
        );
        await stop();
        stop = undefined;
        expect(f.metadataRows().map((row) => row.name)).toEqual(
            Array(4).fill("version-0"),
        );
        const replacement = f.replace();
        stop = await start();
        await drainQueueOutbox(f.outbox, queue);
        await waitForFixture(
            () => delivered.length === 4,
            "replacement metadata root and distinct tail",
        );
        await stop();
        stop = undefined;
        expect(replacement.jobId).not.toBe(f.root.jobId);
        expect(delivered[1].jobId).toBe(`${f.root.jobId}:cursor:3`);
        expect(delivered[3].jobId).toBe(`${replacement.jobId}:cursor:3`);
        expect(delivered[3].onchainBlock).toEqual(replacement.onchainBlock);
        expect(delivered[3].collectionId).toBe(f.collectionId);
        expect(
            f.uriReads
                .filter((read) => read.version === 1)
                .map((read) => read.tokenId),
        ).toEqual(["1", "2", "3", "4"]);
        expect(f.metadataRows().map((row) => row.name)).toEqual(
            Array(4).fill("version-1"),
        );
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS count FROM queue_outbox WHERE retry_policy = ? AND job_kind = ?",
                )
                .get(
                    QUEUE_OUTBOX_RETRY_POLICY.Required,
                    DOMAIN_JOB_KIND.MetadataRefreshRange,
                ),
        ).toEqual({ count: 0 });
    });
});
