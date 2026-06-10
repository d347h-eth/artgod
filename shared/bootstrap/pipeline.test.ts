import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_STEP_STATUS,
    BOOTSTRAP_TASK_STATUS,
    isBootstrapRunStatus,
    isBootstrapStepTerminalStatus,
    isBootstrapTaskStatus,
    mapBootstrapTaskStatusCounts,
} from "./pipeline.js";

describe("bootstrap pipeline contract", () => {
    it("narrows persisted run and task statuses", () => {
        expect(isBootstrapRunStatus(BOOTSTRAP_RUN_STATUS.Metadata)).toBe(true);
        expect(isBootstrapRunStatus("unknown")).toBe(false);
        expect(isBootstrapTaskStatus(BOOTSTRAP_TASK_STATUS.Retry)).toBe(true);
        expect(isBootstrapTaskStatus("running")).toBe(false);
    });

    it("identifies terminal step statuses", () => {
        expect(
            isBootstrapStepTerminalStatus(BOOTSTRAP_STEP_STATUS.Succeeded),
        ).toBe(true);
        expect(
            isBootstrapStepTerminalStatus(
                BOOTSTRAP_STEP_STATUS.FailedTerminal,
            ),
        ).toBe(true);
        expect(
            isBootstrapStepTerminalStatus(BOOTSTRAP_STEP_STATUS.Skipped),
        ).toBe(true);
        expect(isBootstrapStepTerminalStatus(BOOTSTRAP_STEP_STATUS.Running)).toBe(
            false,
        );
    });

    it("maps grouped task status rows into API counts", () => {
        expect(
            mapBootstrapTaskStatusCounts([
                { status: BOOTSTRAP_TASK_STATUS.Pending, count: 2 },
                { status: BOOTSTRAP_TASK_STATUS.Retry, count: 3 },
                { status: BOOTSTRAP_TASK_STATUS.Succeeded, count: 5n },
                { status: BOOTSTRAP_TASK_STATUS.FailedTerminal, count: 7 },
            ]),
        ).toEqual({
            pending: 2,
            retry: 3,
            succeeded: 5,
            failedTerminal: 7,
            total: 17,
        });
    });
});
