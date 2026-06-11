import { describe, expect, it } from "vitest";
import {
    BOOTSTRAP_RUN_STATUS,
    BOOTSTRAP_RECOVERABLE_STEP_STATUSES,
    BOOTSTRAP_STEP_STATUS,
    BOOTSTRAP_TASK_STATUS,
    isBootstrapRunStatus,
    isBootstrapStepTerminalStatus,
    isBootstrapTaskTerminalStatus,
    isBootstrapTaskStatus,
    mapBootstrapTaskStatusCounts,
    serializeBootstrapStepDependencies,
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_ACTION,
    areBootstrapStepDependenciesSatisfied,
    canPauseBootstrapStepStatus,
    canResumeBootstrapStepStatus,
    isBootstrapStepAction,
    parseBootstrapStepDependencies,
    isBootstrapStepKey,
    isBootstrapStepPausable,
    isBootstrapStepWakeableStatus,
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
        expect(BOOTSTRAP_RECOVERABLE_STEP_STATUSES).toContain(
            BOOTSTRAP_STEP_STATUS.Pending,
        );
        expect(BOOTSTRAP_RECOVERABLE_STEP_STATUSES).not.toContain(
            BOOTSTRAP_STEP_STATUS.Paused,
        );
    });

    it("identifies terminal task statuses", () => {
        expect(
            isBootstrapTaskTerminalStatus(BOOTSTRAP_TASK_STATUS.Succeeded),
        ).toBe(true);
        expect(
            isBootstrapTaskTerminalStatus(
                BOOTSTRAP_TASK_STATUS.FailedTerminal,
            ),
        ).toBe(true);
        expect(
            isBootstrapTaskTerminalStatus(BOOTSTRAP_TASK_STATUS.Pending),
        ).toBe(false);
        expect(isBootstrapTaskTerminalStatus(BOOTSTRAP_TASK_STATUS.Retry)).toBe(
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

    it("serializes step dependencies as stable JSON arrays", () => {
        expect(
            serializeBootstrapStepDependencies([
                BOOTSTRAP_STEP_KEY.Anchor,
                BOOTSTRAP_STEP_KEY.Enumeration,
            ]),
        ).toBe('["anchor","enumeration"]');
        expect(
            parseBootstrapStepDependencies(
                serializeBootstrapStepDependencies([
                    BOOTSTRAP_STEP_KEY.Anchor,
                    BOOTSTRAP_STEP_KEY.Enumeration,
                ]),
            ),
        ).toEqual([
            BOOTSTRAP_STEP_KEY.Anchor,
            BOOTSTRAP_STEP_KEY.Enumeration,
        ]);
        expect(
            parseBootstrapStepDependencies('["anchor","unknown"]'),
        ).toEqual([BOOTSTRAP_STEP_KEY.Anchor]);
        expect(parseBootstrapStepDependencies("{")).toEqual([]);
    });

    it("checks bootstrap step dependency satisfaction", () => {
        expect(
            areBootstrapStepDependenciesSatisfied(
                [BOOTSTRAP_STEP_KEY.Anchor],
                [
                    {
                        stepKey: BOOTSTRAP_STEP_KEY.Anchor,
                        status: BOOTSTRAP_STEP_STATUS.Succeeded,
                    },
                ],
            ),
        ).toBe(true);
        expect(
            areBootstrapStepDependenciesSatisfied(
                [BOOTSTRAP_STEP_KEY.ImageCache],
                [
                    {
                        stepKey: BOOTSTRAP_STEP_KEY.ImageCache,
                        status: BOOTSTRAP_STEP_STATUS.Skipped,
                    },
                ],
            ),
        ).toBe(true);
        expect(
            areBootstrapStepDependenciesSatisfied(
                [BOOTSTRAP_STEP_KEY.Metadata],
                [
                    {
                        stepKey: BOOTSTRAP_STEP_KEY.Metadata,
                        status: BOOTSTRAP_STEP_STATUS.FailedTerminal,
                    },
                ],
            ),
        ).toBe(false);
    });

    it("owns bootstrap step action and pausable-step rules", () => {
        expect(isBootstrapStepKey(BOOTSTRAP_STEP_KEY.ImageCache)).toBe(true);
        expect(isBootstrapStepKey("queued")).toBe(false);
        expect(isBootstrapStepAction(BOOTSTRAP_STEP_ACTION.Pause)).toBe(true);
        expect(isBootstrapStepAction("restart")).toBe(false);
        expect(isBootstrapStepPausable(BOOTSTRAP_STEP_KEY.Metadata)).toBe(true);
        expect(isBootstrapStepPausable(BOOTSTRAP_STEP_KEY.Ownership)).toBe(
            false,
        );
        expect(canPauseBootstrapStepStatus(BOOTSTRAP_STEP_STATUS.Running)).toBe(
            true,
        );
        expect(canPauseBootstrapStepStatus(BOOTSTRAP_STEP_STATUS.Pending)).toBe(
            false,
        );
        expect(canResumeBootstrapStepStatus(BOOTSTRAP_STEP_STATUS.Paused)).toBe(
            true,
        );
        expect(canResumeBootstrapStepStatus(BOOTSTRAP_STEP_STATUS.Ready)).toBe(
            false,
        );
        expect(isBootstrapStepWakeableStatus(BOOTSTRAP_STEP_STATUS.Ready)).toBe(
            true,
        );
        expect(
            isBootstrapStepWakeableStatus(BOOTSTRAP_STEP_STATUS.FailedRetry),
        ).toBe(true);
        expect(
            isBootstrapStepWakeableStatus(BOOTSTRAP_STEP_STATUS.Paused),
        ).toBe(false);
    });
});
