import { describe, expect, it, vi } from "vitest";
import {
    NATS_JOB_STREAM_MAX_AGE_NANOS,
    resolveNatsJobSubject,
} from "@artgod/shared/queue/nats-job-stream";
import {
    MaintainNatsJobStream,
    planAcknowledgedJobStreamCleanup,
    type NatsJobStreamConsumerSnapshot,
    type NatsJobStreamSnapshot,
    type NatsJobStreamWriteProbe,
} from "../src/application/queue/maintain-nats-job-stream.js";

import {
    consumer,
    snapshot,
    PREFIX,
    SUBJECT,
} from "./fixtures/nats-job-stream.js";

const WRITABLE: NatsJobStreamWriteProbe = {
    writable: true,
    resourceLimited: false,
    error: null,
};
const LIMITED: NatsJobStreamWriteProbe = {
    writable: false,
    resourceLimited: true,
    error: "storage limit",
};

function fixture(state: NatsJobStreamSnapshot, probe = WRITABLE) {
    const administration = {
        inspect: vi.fn().mockResolvedValue(state),
        reconcileMaxAge: vi.fn().mockResolvedValue(undefined),
        removeAcknowledged: vi.fn().mockResolvedValue(20),
        probeWritable: vi.fn().mockResolvedValue(probe),
    };
    return {
        administration,
        useCase: new MaintainNatsJobStream(administration, { report: vi.fn() }),
    };
}

describe("acknowledged jobs cleanup", () => {
    it("scopes cleanup behind the ACK floor while preserving newer pending work of any age", () => {
        expect(planAcknowledgedJobStreamCleanup(snapshot())).toEqual([
            {
                streamCreated: "2026-08-01T00:00:00Z",
                subject: SUBJECT,
                throughSequence: 50,
                consumer: consumer(),
            },
        ]);
    });

    it.each<Partial<NatsJobStreamConsumerSnapshot>>([
        { ackPending: 1 },
        { redelivered: 1 },
        { ackFloorStreamSequence: 49 },
        { ackFloorConsumerSequence: 19 },
        { deliveredConsumerSequence: 0, ackFloorConsumerSequence: 0 },
        { durable: false },
        { deliversAll: false },
        { explicitAck: false },
        { created: "" },
        { firstRetainedSequence: 51 },
        { firstRetainedSequence: null },
        { firstRetainedSequence: 0 },
        { pending: -1 },
        {
            ackFloorStreamSequence: Number.MAX_SAFE_INTEGER,
            deliveredStreamSequence: Number.MAX_SAFE_INTEGER,
        },
        { filterSubjects: [] },
        { filterSubjects: ["test.jobs.*"] },
        { filterSubjects: [SUBJECT, resolveNatsJobSubject(PREFIX, "other")] },
    ])(
        "does not infer completed leftovers from unsupported or uncertain state: %j",
        (overrides) => {
            expect(
                planAcknowledgedJobStreamCleanup(
                    snapshot([consumer(overrides)]),
                ),
            ).toEqual([]);
        },
    );

    it("leaves a healthy old backlog, uncovered subjects and in-flight work alone", () => {
        const inFlight = consumer({
            name: "inflight",
            filterSubjects: [resolveNatsJobSubject(PREFIX, "inflight")],
            ackPending: 1,
        });
        const healthy = consumer({
            name: "healthy",
            filterSubjects: [resolveNatsJobSubject(PREFIX, "healthy")],
            firstRetainedSequence: 80,
        });
        expect(
            planAcknowledgedJobStreamCleanup(
                snapshot([consumer(), inFlight, healthy]),
            ),
        ).toHaveLength(1);
        expect(planAcknowledgedJobStreamCleanup(snapshot([]))).toEqual([]);
    });

    it("refuses ambiguous ownership and incomplete consumer enumeration", () => {
        expect(
            planAcknowledgedJobStreamCleanup(
                snapshot([consumer(), consumer({ name: "duplicate" })]),
            ),
        ).toEqual([]);
        const incomplete = snapshot();
        incomplete.stream!.consumerCount++;
        expect(planAcknowledgedJobStreamCleanup(incomplete)).toEqual([]);
        expect(
            planAcknowledgedJobStreamCleanup(
                snapshot([
                    consumer(),
                    consumer({ name: "wild", filterSubjects: [">"] }),
                ]),
            ),
        ).toEqual([]);
    });

    it("requires a work queue with expiry disabled", () => {
        const state = snapshot();
        state.stream!.workQueue = false;
        expect(planAcknowledgedJobStreamCleanup(state)).toEqual([]);
        state.stream!.workQueue = true;
        state.stream!.maxAgeNanos = 1;
        expect(planAcknowledgedJobStreamCleanup(state)).toEqual([]);
    });
});

describe("MaintainNatsJobStream", () => {
    it("does no cleanup for a healthy backlog even after days offline", async () => {
        const { administration, useCase } = fixture(
            snapshot([consumer({ firstRetainedSequence: 80 })]),
        );
        expect(await useCase.execute()).toMatchObject({ purged: false });
        expect(administration.removeAcknowledged).not.toHaveBeenCalled();
        expect(administration.reconcileMaxAge).toHaveBeenCalledWith(
            NATS_JOB_STREAM_MAX_AGE_NANOS,
        );
    });

    it("removes only proven completed leftovers even without current storage pressure", async () => {
        const { administration, useCase } = fixture(snapshot());
        expect(await useCase.execute()).toMatchObject({
            purged: true,
            purgedMessages: 20,
        });
        expect(
            administration.removeAcknowledged,
        ).toHaveBeenCalledExactlyOnceWith(
            planAcknowledgedJobStreamCleanup(snapshot())[0],
        );
    });

    it("recovers storage pressure only through acknowledged cleanup", async () => {
        const { administration, useCase } = fixture(snapshot(), LIMITED);
        administration.probeWritable
            .mockResolvedValueOnce(LIMITED)
            .mockResolvedValueOnce(LIMITED)
            .mockResolvedValueOnce(WRITABLE);
        expect(await useCase.execute()).toMatchObject({ purged: true });
    });

    it("fails without deleting valid pending work when storage stays full", async () => {
        const { administration, useCase } = fixture(
            snapshot([consumer({ firstRetainedSequence: 80 })]),
            LIMITED,
        );
        await expect(useCase.execute()).rejects.toThrow(
            "queued work was preserved",
        );
        expect(administration.removeAcknowledged).not.toHaveBeenCalled();
    });

    it.each(["503", "permission denied", "probe cleanup failed"])(
        "does not delete on unrelated failure: %s",
        async (error) => {
            const { administration, useCase } = fixture(snapshot(), {
                writable: false,
                resourceLimited: false,
                error,
            });
            await expect(useCase.execute()).rejects.toThrow(error);
            expect(administration.removeAcknowledged).not.toHaveBeenCalled();
            expect(administration.reconcileMaxAge).not.toHaveBeenCalled();
        },
    );

    it("does not let an earlier storage error mask a later unrelated failure", async () => {
        const { administration, useCase } = fixture(snapshot(), LIMITED);
        administration.probeWritable
            .mockResolvedValueOnce(LIMITED)
            .mockResolvedValueOnce({
                writable: false,
                resourceLimited: false,
                error: "503",
            });
        await expect(useCase.execute()).rejects.toThrow("503");
        expect(administration.removeAcknowledged).not.toHaveBeenCalled();
    });

    it("reports failure if safe cleanup did not restore writes", async () => {
        const { administration, useCase } = fixture(snapshot(), LIMITED);
        await expect(useCase.execute()).rejects.toThrow(
            "queued work was preserved",
        );
        expect(administration.removeAcknowledged).toHaveBeenCalledTimes(1);
    });

    it("aborts before later subjects when revalidation/cleanup fails", async () => {
        const state = snapshot([
            consumer(),
            consumer({
                name: "other",
                filterSubjects: [resolveNatsJobSubject(PREFIX, "other")],
            }),
        ]);
        const { administration, useCase } = fixture(state);
        administration.removeAcknowledged.mockRejectedValue(
            new Error("evidence changed"),
        );
        await expect(useCase.execute()).rejects.toThrow("evidence changed");
        expect(administration.removeAcknowledged).toHaveBeenCalledTimes(1);
    });
});
