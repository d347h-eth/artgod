import { describe, expect, it, vi } from "vitest";
import { NATS_JOB_STREAM_MAX_AGE_NANOS } from "@artgod/shared/queue/nats-job-stream";
import {
    MaintainNatsJobStream,
    NATS_JOB_STREAM_MAINTENANCE_EVENT,
    type NatsJobStreamMaintenanceEvent,
    type NatsJobStreamSnapshot,
    type NatsJobStreamWriteProbe,
} from "../src/application/queue/maintain-nats-job-stream.js";

const WRITABLE_PROBE: NatsJobStreamWriteProbe = {
    writable: true,
    resourceLimited: false,
    error: null,
};
const LIMITED_PROBE: NatsJobStreamWriteProbe = {
    writable: false,
    resourceLimited: true,
    error: "503",
};

describe("MaintainNatsJobStream", () => {
    it("records upgrade-only health and verifies writes after policy reconciliation", async () => {
        const administration = new FakeAdministration(
            [
                snapshot({ maxAgeNanos: NATS_JOB_STREAM_MAX_AGE_NANOS + 1 }),
                snapshot(),
                snapshot(),
            ],
            [WRITABLE_PROBE, WRITABLE_PROBE],
        );
        const { useCase, events } = fixture(administration);

        const result = await useCase.execute();

        expect(result.purged).toBe(false);
        expect(administration.reconciledMaxAges).toEqual([
            NATS_JOB_STREAM_MAX_AGE_NANOS,
        ]);
        expect(administration.purgeCalls).toBe(0);
        expect(events.map((event) => event.kind)).toEqual([
            NATS_JOB_STREAM_MAINTENANCE_EVENT.UpgradeObservation,
            NATS_JOB_STREAM_MAINTENANCE_EVENT.UpgradeWriteProbe,
            NATS_JOB_STREAM_MAINTENANCE_EVENT.PolicyReconciled,
            NATS_JOB_STREAM_MAINTENANCE_EVENT.WriteVerified,
            NATS_JOB_STREAM_MAINTENANCE_EVENT.Completed,
        ]);
    });

    it("waits while MaxAge cleanup makes progress and avoids a purge", async () => {
        const administration = new FakeAdministration(
            [
                snapshot({ storageBytes: 120 }),
                snapshot({ storageBytes: 100 }),
                snapshot({ storageBytes: 80 }),
                snapshot({ storageBytes: 80 }),
            ],
            [LIMITED_PROBE, WRITABLE_PROBE],
        );
        const { useCase, events } = fixture(administration);

        const result = await useCase.execute();

        expect(result.purged).toBe(false);
        expect(administration.purgeCalls).toBe(0);
        expect(events.map((event) => event.kind)).toContain(
            NATS_JOB_STREAM_MAINTENANCE_EVENT.ExpiryProgress,
        );
    });

    it("purges only after storage-limit recovery stalls", async () => {
        const administration = new FakeAdministration(
            [
                snapshot({ storageBytes: 100 }),
                snapshot({ storageBytes: 100 }),
                snapshot({ storageBytes: 100 }),
                snapshot({ storageBytes: 0, messages: 0 }),
                snapshot({ storageBytes: 0, messages: 0 }),
            ],
            [LIMITED_PROBE, LIMITED_PROBE, WRITABLE_PROBE],
            41,
        );
        const { useCase, events } = fixture(administration, {
            expiryPollIntervalMs: 5,
            expiryStallTimeoutMs: 5,
            expiryMaxWaitMs: 20,
        });

        const result = await useCase.execute();

        expect(result).toMatchObject({
            purged: true,
            purgedMessages: 41,
        });
        expect(administration.purgeCalls).toBe(1);
        expect(events.map((event) => event.kind)).toContain(
            NATS_JOB_STREAM_MAINTENANCE_EVENT.PurgeStarted,
        );
    });

    it("recovers a server-global limit even when account max storage is unlimited", async () => {
        const administration = new FakeAdministration(
            [
                snapshot({ maxStorageBytes: -1 }),
                snapshot({ maxStorageBytes: -1 }),
                snapshot({ maxStorageBytes: -1 }),
                snapshot({
                    maxStorageBytes: -1,
                    storageBytes: 0,
                    messages: 0,
                }),
                snapshot({
                    maxStorageBytes: -1,
                    storageBytes: 0,
                    messages: 0,
                }),
            ],
            [LIMITED_PROBE, LIMITED_PROBE, WRITABLE_PROBE],
            12,
        );
        const { useCase } = fixture(administration, {
            expiryPollIntervalMs: 5,
            expiryStallTimeoutMs: 5,
            expiryMaxWaitMs: 20,
        });

        const result = await useCase.execute();

        expect(result.purged).toBe(true);
        expect(administration.purgeCalls).toBe(1);
    });

    it.each(["permission denied", "503"])(
        "does not mutate the stream after a non-storage probe failure: %s",
        async (error) => {
            const administration = new FakeAdministration(
                [snapshot()],
                [
                    {
                        writable: false,
                        resourceLimited: false,
                        error,
                    },
                ],
            );
            const { useCase } = fixture(administration);

            await expect(useCase.execute()).rejects.toThrow(error);
            expect(administration.reconciledMaxAges).toEqual([]);
            expect(administration.purgeCalls).toBe(0);
        },
    );

    it("does not purge after an unrelated post-policy probe failure", async () => {
        const administration = new FakeAdministration(
            [snapshot(), snapshot()],
            [
                WRITABLE_PROBE,
                { writable: false, resourceLimited: false, error: "503" },
            ],
        );
        const { useCase } = fixture(administration);

        await expect(useCase.execute()).rejects.toThrow("503");
        expect(administration.purgeCalls).toBe(0);
    });
});

class FakeAdministration {
    readonly reconciledMaxAges: number[] = [];
    purgeCalls = 0;

    constructor(
        private readonly snapshots: NatsJobStreamSnapshot[],
        private readonly probes: NatsJobStreamWriteProbe[],
        private readonly purgedMessages = 0,
    ) {}

    async inspect(): Promise<NatsJobStreamSnapshot> {
        const value =
            this.snapshots.length > 1
                ? this.snapshots.shift()
                : this.snapshots[0];
        if (!value) throw new Error("Missing inspection fixture");
        return value;
    }

    async reconcileMaxAge(maxAgeNanos: number): Promise<void> {
        this.reconciledMaxAges.push(maxAgeNanos);
    }

    async purge(): Promise<number> {
        this.purgeCalls += 1;
        return this.purgedMessages;
    }

    async probeWritable(): Promise<NatsJobStreamWriteProbe> {
        const value =
            this.probes.length > 1 ? this.probes.shift() : this.probes[0];
        if (!value) throw new Error("Missing write probe fixture");
        return value;
    }
}

function fixture(
    administration: FakeAdministration,
    policy = {
        expiryPollIntervalMs: 5,
        expiryStallTimeoutMs: 10,
        expiryMaxWaitMs: 30,
    },
) {
    let now = 0;
    const events: NatsJobStreamMaintenanceEvent[] = [];
    const reporter = {
        report: vi.fn((event: NatsJobStreamMaintenanceEvent) =>
            events.push(event),
        ),
    };
    return {
        useCase: new MaintainNatsJobStream(
            administration,
            reporter,
            {
                now: () => now,
                sleep: async (delayMs) => {
                    now += delayMs;
                },
            },
            policy,
        ),
        events,
    };
}

function snapshot(
    overrides: {
        maxAgeNanos?: number;
        storageBytes?: number;
        maxStorageBytes?: number;
        messages?: number;
    } = {},
): NatsJobStreamSnapshot {
    return {
        stream: {
            name: "artgod-jobs",
            maxAgeNanos: overrides.maxAgeNanos ?? NATS_JOB_STREAM_MAX_AGE_NANOS,
            messages: overrides.messages ?? 10,
            bytes: overrides.storageBytes ?? 100,
            firstSequence: 1,
            firstTimestamp: "2026-08-10T00:00:00.000Z",
            lastSequence: 10,
            lastTimestamp: "2026-08-11T00:00:00.000Z",
            consumerCount: 1,
        },
        account: {
            storageBytes: overrides.storageBytes ?? 100,
            maxStorageBytes: overrides.maxStorageBytes ?? -1,
        },
        consumers: [],
    };
}
