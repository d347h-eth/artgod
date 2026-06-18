import type { BootstrapStepSchedulerResult } from "./bootstrap-step-scheduler.js";

export type BootstrapLanePollerRunInput = {
    runId?: number | null;
    traceId: string;
};

export type BootstrapLanePollerHooks = {
    onCompleted?(result: BootstrapStepSchedulerResult): void;
    onFailed?(error: unknown): void;
};

export type BootstrapLanePollerTimer = ReturnType<typeof setTimeout>;

export type BootstrapLanePollerClock = {
    nowMs(): number;
    setTimer(callback: () => void, delayMs: number): BootstrapLanePollerTimer;
    clearTimer(timer: BootstrapLanePollerTimer): void;
};

export type BootstrapLanePollerStop = () => Promise<void>;

// Runs a bootstrap scheduler lane on bounded durable-state polling.
export function startBootstrapLanePoller(input: {
    laneName: string;
    traceIdPrefix: string;
    pollMinMs: number;
    pollMaxMs: number;
    run: (
        pollInput: BootstrapLanePollerRunInput,
    ) => Promise<BootstrapStepSchedulerResult>;
    hooks?: BootstrapLanePollerHooks;
    clock?: BootstrapLanePollerClock;
}): BootstrapLanePollerStop {
    const clock = input.clock ?? SYSTEM_BOOTSTRAP_LANE_POLLER_CLOCK;
    let stopped = false;
    let running = false;
    let timer: BootstrapLanePollerTimer | null = null;
    let activePoll: Promise<void> | null = null;

    const schedule = (nextDueAt: number | null): void => {
        if (stopped) {
            return;
        }
        if (timer) {
            clock.clearTimer(timer);
        }
        timer = clock.setTimer(
            () => {
                poll().catch(() => {});
            },
            resolveBootstrapLanePollDelayMs({
                nextDueAt,
                pollMinMs: input.pollMinMs,
                pollMaxMs: input.pollMaxMs,
                nowMs: clock.nowMs(),
            }),
        );
    };

    const poll = async (): Promise<void> => {
        if (stopped) {
            return;
        }
        if (running) {
            schedule(null);
            return;
        }
        running = true;
        const pollPromise = runPoll();
        activePoll = pollPromise;
        try {
            await pollPromise;
        } finally {
            if (activePoll === pollPromise) {
                activePoll = null;
            }
        }
    };

    const runPoll = async (): Promise<void> => {
        let nextDueAt: number | null = null;
        try {
            const result = await input.run({
                runId: null,
                traceId: buildBootstrapLanePollTraceId(
                    input.traceIdPrefix,
                    input.laneName,
                    clock.nowMs(),
                ),
            });
            nextDueAt = result.nextDueAt;
            input.hooks?.onCompleted?.(result);
        } catch (error) {
            input.hooks?.onFailed?.(error);
        } finally {
            running = false;
            schedule(nextDueAt);
        }
    };

    schedule(0);

    return async () => {
        stopped = true;
        if (timer) {
            clock.clearTimer(timer);
            timer = null;
        }
        if (activePoll) {
            await activePoll;
        }
    };
}

// Clamps the next lane poll to the configured floor and ceiling.
export function resolveBootstrapLanePollDelayMs(input: {
    nextDueAt: number | null;
    pollMinMs: number;
    pollMaxMs: number;
    nowMs: number;
}): number {
    const pollMinMs = Math.max(1, input.pollMinMs);
    const pollMaxMs = Math.max(pollMinMs, input.pollMaxMs);
    if (input.nextDueAt === null) {
        return pollMaxMs;
    }
    const dueDelay = Math.max(0, input.nextDueAt - input.nowMs);
    return Math.min(pollMaxMs, Math.max(pollMinMs, dueDelay));
}

function buildBootstrapLanePollTraceId(
    traceIdPrefix: string,
    laneName: string,
    nowMs: number,
): string {
    return `${traceIdPrefix}:${laneName}:${nowMs}`;
}

const SYSTEM_BOOTSTRAP_LANE_POLLER_CLOCK: BootstrapLanePollerClock = {
    nowMs: Date.now,
    setTimer: setTimeout,
    clearTimer: clearTimeout,
};
