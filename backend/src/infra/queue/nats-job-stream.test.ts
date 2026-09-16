import { describe, expect, it, vi } from "vitest";
import { NATS_JOB_STREAM_MAX_AGE_NANOS } from "@artgod/shared/queue/nats-job-stream";
import { ensureNatsJobStream } from "./nats-job-stream.js";

describe("ensureNatsJobStream", () => {
    it("updates MaxAge on an installed stream", async () => {
        const manager = managerFixture({
            config: {
                max_age: NATS_JOB_STREAM_MAX_AGE_NANOS + 1,
            },
        });

        await ensureNatsJobStream(manager.value, "artgod");

        expect(manager.update).toHaveBeenCalledWith("artgod-jobs", {
            max_age: NATS_JOB_STREAM_MAX_AGE_NANOS,
        });
        expect(manager.add).not.toHaveBeenCalled();
    });

    it("creates a missing stream with the canonical contract", async () => {
        const missing = Object.assign(new Error("missing"), { code: "404" });
        const manager = managerFixture(null, missing);

        await ensureNatsJobStream(manager.value, "artgod");

        expect(manager.add).toHaveBeenCalledWith({
            name: "artgod-jobs",
            subjects: ["artgod.jobs.>"],
            retention: "workqueue",
            storage: "file",
            max_age: NATS_JOB_STREAM_MAX_AGE_NANOS,
        });
        expect(manager.update).not.toHaveBeenCalled();
    });

    it("does not hide a stream inspection failure", async () => {
        const manager = managerFixture(null, new Error("permission denied"));

        await expect(
            ensureNatsJobStream(manager.value, "artgod"),
        ).rejects.toThrow("permission denied");
        expect(manager.add).not.toHaveBeenCalled();
    });
});

function managerFixture(
    streamInfo: { config: { max_age: number } } | null,
    infoError?: Error,
) {
    const info = infoError
        ? vi.fn().mockRejectedValue(infoError)
        : vi.fn().mockResolvedValue(streamInfo);
    const add = vi.fn().mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    return {
        value: {
            streams: { info, add, update },
        } as unknown as Parameters<typeof ensureNatsJobStream>[0],
        info,
        add,
        update,
    };
}
