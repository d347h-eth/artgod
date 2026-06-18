import { describe, expect, it } from "vitest";
import { BOOTSTRAP_STEP_KEY } from "@artgod/shared/bootstrap/pipeline";
import {
    resolveBootstrapLanePollDelayMs,
    startBootstrapLanePoller,
    type BootstrapLanePollerClock,
    type BootstrapLanePollerTimer,
} from "../src/application/bootstrap-lane-poller.js";
import type { BootstrapStepSchedulerResult } from "../src/application/bootstrap-step-scheduler.js";

const TEST_LANE_NAME = "test_lane";
const TEST_TRACE_PREFIX = "bootstrap:test-poll";

describe("bootstrap lane poller", () => {
    it("clamps poll delay to the configured floor and ceiling", () => {
        expect(
            resolveBootstrapLanePollDelayMs({
                nextDueAt: null,
                pollMinMs: 100,
                pollMaxMs: 5_000,
                nowMs: 1_000,
            }),
        ).toBe(5_000);
        expect(
            resolveBootstrapLanePollDelayMs({
                nextDueAt: 1_050,
                pollMinMs: 100,
                pollMaxMs: 5_000,
                nowMs: 1_000,
            }),
        ).toBe(100);
        expect(
            resolveBootstrapLanePollDelayMs({
                nextDueAt: 20_000,
                pollMinMs: 100,
                pollMaxMs: 5_000,
                nowMs: 1_000,
            }),
        ).toBe(5_000);
    });

    it("polls the lane and reschedules from the scheduler next due timestamp", async () => {
        let nowMs = 1_000;
        const timers = createTimers(() => nowMs);
        const completed: BootstrapStepSchedulerResult[] = [];
        const runInputs: Array<{ runId?: number | null; traceId: string }> = [];
        const stop = startBootstrapLanePoller({
            laneName: TEST_LANE_NAME,
            traceIdPrefix: TEST_TRACE_PREFIX,
            pollMinMs: 100,
            pollMaxMs: 5_000,
            clock: timers.clock,
            hooks: {
                onCompleted: (result) => {
                    completed.push(result);
                },
            },
            run: async (input) => {
                runInputs.push(input);
                return schedulerResult({ nextDueAt: 1_500 });
            },
        });

        expect(timers.created.map((timer) => timer.delayMs)).toEqual([100]);

        await timers.fireNext();

        expect(runInputs).toEqual([
            {
                runId: null,
                traceId: `${TEST_TRACE_PREFIX}:${TEST_LANE_NAME}:1000`,
            },
        ]);
        expect(completed).toEqual([schedulerResult({ nextDueAt: 1_500 })]);
        expect(timers.created.map((timer) => timer.delayMs)).toEqual([
            100,
            500,
        ]);

        nowMs = 1_500;
        await stop();
        expect(timers.created.at(-1)?.cleared).toBe(true);
    });

    it("reports poll failures and keeps polling at the ceiling", async () => {
        const timers = createTimers(() => 2_000);
        const failures: unknown[] = [];
        const stop = startBootstrapLanePoller({
            laneName: TEST_LANE_NAME,
            traceIdPrefix: TEST_TRACE_PREFIX,
            pollMinMs: 100,
            pollMaxMs: 5_000,
            clock: timers.clock,
            hooks: {
                onFailed: (error) => {
                    failures.push(error);
                },
            },
            run: async () => {
                throw new Error("poll failed");
            },
        });

        await timers.fireNext();

        expect(String(failures[0])).toBe("Error: poll failed");
        expect(timers.created.map((timer) => timer.delayMs)).toEqual([
            100,
            5_000,
        ]);

        await stop();
    });
});

function schedulerResult(input: {
    nextDueAt: number | null;
}): BootstrapStepSchedulerResult {
    return {
        chainId: 1,
        runIds: [41],
        claimedStepKeys: [BOOTSTRAP_STEP_KEY.Metadata],
        readyStepKeys: [],
        wakeStepKeys: [],
        nextDueAt: input.nextDueAt,
    };
}

function createTimers(nowMs: () => number): {
    clock: BootstrapLanePollerClock;
    created: TestTimer[];
    fireNext(): Promise<void>;
} {
    const created: TestTimer[] = [];
    const clock: BootstrapLanePollerClock = {
        nowMs,
        setTimer(callback, delayMs) {
            const timer = { callback, delayMs, cleared: false };
            created.push(timer);
            return timer as unknown as BootstrapLanePollerTimer;
        },
        clearTimer(timer) {
            (timer as unknown as TestTimer).cleared = true;
        },
    };
    return {
        clock,
        created,
        async fireNext() {
            const timer = created.find((candidate) => !candidate.cleared);
            if (!timer) {
                throw new Error("No active test timer");
            }
            timer.callback();
            await Promise.resolve();
            await Promise.resolve();
        },
    };
}

type TestTimer = {
    callback: () => void;
    delayMs: number;
    cleared: boolean;
};
