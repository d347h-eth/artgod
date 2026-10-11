import { afterEach, expect, it, vi } from "vitest";
import {
    flushPendingLogReports,
    LOG_REPORTING_POLICY as POLICY,
    WindowedLogReporter,
} from "./log-reporting.js";

afterEach(() => {
    flushPendingLogReports();
    vi.useRealTimers();
});

it("reports a large burst in one minute without retaining individual observations or emitting idle heartbeats", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const emit = vi.fn();
    const report = new WindowedLogReporter(() => ({ count: 0 }), emit);
    for (let i = 0; i < 100_000; i++) report.record((state) => state.count++);
    expect(emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(POLICY.intervalMs);
    expect(emit).toHaveBeenCalledExactlyOnceWith(
        { count: 100_000 },
        {
            startedAt: 0,
            endedAt: POLICY.intervalMs,
            windowMs: POLICY.intervalMs,
        },
    );
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(10 * POLICY.intervalMs);
    report.record((state) => state.count++);
    const startedAt = Date.now();
    vi.advanceTimersByTime(POLICY.intervalMs - 1);
    expect(emit).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(emit).toHaveBeenLastCalledWith(
        { count: 1 },
        { startedAt, endedAt: Date.now(), windowMs: POLICY.intervalMs },
    );
});

it("flushes partial windows once during shutdown and cancels their timers", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const emit = vi.fn();
    const report = new WindowedLogReporter(() => ({ count: 0 }), emit);
    report.record((state) => state.count++);
    vi.advanceTimersByTime(50);
    flushPendingLogReports();
    flushPendingLogReports();
    expect(emit).toHaveBeenCalledExactlyOnceWith(
        { count: 1 },
        { startedAt: 0, endedAt: 50, windowMs: 50 },
    );
    expect(vi.getTimerCount()).toBe(0);
});

it("resets counters when a diagnostic sink fails without failing the completed work", () => {
    vi.useFakeTimers();
    const emit = vi.fn().mockImplementationOnce(() => {
        throw new Error("diagnostic sink failed");
    });
    const report = new WindowedLogReporter(() => ({ count: 0 }), emit);
    report.record((state) => state.count++);
    expect(() => flushPendingLogReports()).not.toThrow();
    report.record((state) => state.count++);
    flushPendingLogReports();
    expect(emit).toHaveBeenLastCalledWith({ count: 1 }, expect.any(Object));
    expect(vi.getTimerCount()).toBe(0);
});

it("flushes on an overdue observation even if the event loop has not run the timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const emit = vi.fn();
    const report = new WindowedLogReporter(() => ({ count: 0 }), emit);
    report.record((state) => state.count++);
    vi.setSystemTime(POLICY.intervalMs + 100);
    report.record((state) => state.count++);
    expect(emit).toHaveBeenCalledExactlyOnceWith(
        { count: 2 },
        {
            startedAt: 0,
            endedAt: Date.now(),
            windowMs: POLICY.intervalMs + 100,
        },
    );
    expect(vi.getTimerCount()).toBe(0);
});
