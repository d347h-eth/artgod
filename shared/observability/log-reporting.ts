/** Shared cadence for bounded progress logs, independent of metric exporters. */
export const LOG_REPORTING_POLICY = Object.freeze({ intervalMs: 60_000 });

export type LogReportWindow = {
    startedAt: number;
    endedAt: number;
    windowMs: number;
};

const pendingReports = new Set<{ flush(): void }>();

/** Call after draining work during graceful shutdown, before closing exporters. */
export function flushPendingLogReports(): void {
    for (const report of [...pendingReports]) report.flush();
}

/** Owns only window timing; callers own fixed-size counters and log contracts. */
export class WindowedLogReporter<State> {
    private state: State;
    private startedAt: number;
    private dirty = false;
    private timer?: ReturnType<typeof setTimeout>;

    constructor(
        private readonly empty: () => State,
        private readonly emit: (state: State, window: LogReportWindow) => void,
        private readonly now: () => number = Date.now,
    ) {
        this.state = empty();
        this.startedAt = now();
    }

    record(update?: (state: State) => void): void {
        const at = this.now();
        if (update) {
            // A new burst after a long idle period starts a fresh reporting window.
            if (
                !this.dirty &&
                at - this.startedAt >= LOG_REPORTING_POLICY.intervalMs
            )
                this.startedAt = at;
            update(this.state);
            this.dirty = true;
            pendingReports.add(this);
            if (!this.timer) {
                this.timer = setTimeout(
                    () => this.flush(),
                    Math.max(
                        0,
                        LOG_REPORTING_POLICY.intervalMs - (at - this.startedAt),
                    ),
                );
                // Reporting must neither keep an idle process alive nor need another event to flush.
                this.timer.unref?.();
            }
        }
        if (at - this.startedAt >= LOG_REPORTING_POLICY.intervalMs)
            this.flush();
    }

    flush(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        pendingReports.delete(this);
        const endedAt = this.now();
        const window = {
            startedAt: this.startedAt,
            endedAt,
            windowMs: Math.max(0, endedAt - this.startedAt),
        };
        const state = this.state;
        const dirty = this.dirty;
        this.state = this.empty();
        this.startedAt = endedAt;
        this.dirty = false;
        if (dirty) {
            try {
                this.emit(state, window);
            } catch {
                // A failed diagnostic sink must not retry an already completed business effect.
            }
        }
    }
}
