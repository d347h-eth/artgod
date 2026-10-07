import { beforeEach, describe, expect, it, vi } from "vitest";
import { setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { runWorker } from "../src/application/worker-runner.js";
import { chunkMetadataTokenRange } from "../src/domain/metadata-refresh-range.js";
import type { MetadataRefreshRangePayload } from "../src/domain/domain-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { QueueMessage, QueuePort } from "../src/ports/queue.js";
import { metadataRangeFixture } from "./helpers/metadata-range-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("metadata range continuation context", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function fixture() {
        const published: JobEnvelope<MetadataRefreshRangePayload>[] = [];
        const queue: Pick<QueuePort, "publish"> = {
            publish: async (_queue, job) => {
                published.push(job as JobEnvelope<MetadataRefreshRangePayload>);
            },
        };
        return { ...metadataRangeFixture({ queue }), published };
    }

    it("keeps one revision-qualified root, origin and collection through three chunks and duplicate publication", async () => {
        const f = fixture();
        await f.handler(f.root);
        const first = f.published[0];
        await f.handler(first);
        const second = f.published[1];
        await f.handler(second);
        expect(f.published).toHaveLength(2);
        expect(f.uriReads.map((read) => read.tokenId)).toEqual([
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
        ]);
        for (const [job, cursor] of [
            [first, "3"],
            [second, "5"],
        ] as const) {
            expect(job.jobId).toBe(`${f.root.jobId}:cursor:${cursor}`);
            expect(job.payload.rootJobId).toBe(f.root.jobId);
            expect(job.onchainBlock).toEqual(f.root.onchainBlock);
            expect(job.collectionId).toBe(f.collectionId);
        }
        await f.handler(f.root);
        expect(f.published[2].jobId).toBe(first.jobId);
    });

    it("ACKs an orphan continuation without admitting another metadata read", async () => {
        const f = fixture();
        await f.handler(f.root);
        const tail = f.published[0];
        f.rollback();
        let consume!: (
            message: QueueMessage<MetadataRefreshRangePayload>,
        ) => Promise<void>;
        const queue = {
            subscribe: async (_queue: unknown, callback: typeof consume) => {
                consume = callback;
                return async () => {};
            },
        } as unknown as QueuePort;
        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.MetadataRefresh,
                consumerName: "metadata-range-unit",
            },
            f.handler,
            { admission: f.admission },
        );
        const ack = vi.fn(async () => {}),
            nack = vi.fn(async () => {});
        await consume({ data: tail, ack, nack, touch: async () => {} });
        await stop();
        expect(ack).toHaveBeenCalledTimes(1);
        expect(nack).not.toHaveBeenCalled();
        expect(f.uriReads.map((read) => read.tokenId)).toEqual(["1", "2"]);
        expect(f.admission.isCurrent(tail)).toBe(false);
    });

    it("supports ordinary and legacy envelopes without fabricating a fork identity", async () => {
        const f = fixture();
        const ordinary = {
            ...f.root,
            jobId: "ordinary-range",
            collectionId: undefined,
            onchainBlock: undefined,
        };
        await f.handler(ordinary);
        const first = f.published[0];
        expect(first.onchainBlock).toBeUndefined();
        expect(first.collectionId).toBe(f.collectionId);
        expect(first.payload.rootJobId).toBe(ordinary.jobId);
        await f.handler(first);
        expect(f.published[1].jobId).toBe(`${ordinary.jobId}:cursor:5`);
        expect(f.admission.isCurrent(first)).toBe(true);
    });

    it("rejects mismatched scope and invalid cursor before remote reads, and accepts an exhausted cursor", async () => {
        const f = fixture();
        await expect(
            f.handler({ ...f.root, collectionId: f.collectionId + 1 }),
        ).rejects.toThrow();
        await expect(
            f.handler({
                ...f.root,
                payload: { ...f.root.payload, cursorTokenId: "0" },
            }),
        ).rejects.toThrow();
        await f.handler({
            ...f.root,
            payload: { ...f.root.payload, cursorTokenId: "7" },
        });
        expect(f.uriReads).toEqual([]);
        expect(f.published).toEqual([]);
        expect(
            chunkMetadataTokenRange({
                fromTokenId: "9007199254740993",
                toTokenId: "9007199254740996",
                cursorTokenId: "9007199254740993",
                chunkSize: 2,
            }),
        ).toEqual({
            tokenIds: ["9007199254740993", "9007199254740994"],
            nextCursorTokenId: "9007199254740995",
        });
    });
});
