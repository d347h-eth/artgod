import { describe, expect, it, vi } from 'vitest';

import { STARTUP_PHASE_EVENT_CODE } from './core/reducer';
import { createLifecycleOrchestrator } from './orchestrator';
import {
	STARTUP_PHASES,
	RECOVERY_TASKS,
	RECOVERY_FAILURE_REASONS,
	type BackendProbePort,
	type RuntimePort,
	type RuntimeStatus
} from './ports';
import type { LifecycleState } from './core/types';

function makeStatus(state: string, overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
	return {
		state,
		operationId: 0,
		revision: 0,
		startup: null,
		recoveryFailure: null,
		restartCount: 0,
		lastError: null,
		runningProcesses: [],
		backendHttpBaseUrl: 'http://127.0.0.1:42710',
		natsUrl: 'nats://127.0.0.1:42720',
		configPath: '/tmp/.env',
		...overrides
	};
}

class FakeClock {
	public nowMs = 0;

	now(): number {
		return this.nowMs;
	}

	async sleep(ms: number): Promise<void> {
		this.nowMs += Math.max(0, ms);
	}
}

class FakeRuntimePort implements RuntimePort {
	public loadBridgeResult = true;
	public bridgeAvailable = false;
	public statusValue: RuntimeStatus | null = makeStatus('stopped');
	public autoStartStatus: RuntimeStatus = makeStatus('running');
	public statusCalls = 0;
	public autoStartCalls = 0;
	private statusListeners: Array<(status: RuntimeStatus) => void> = [];

	async loadBridge(): Promise<boolean> {
		this.bridgeAvailable = this.loadBridgeResult;
		return this.loadBridgeResult;
	}

	isBridgeAvailable(): boolean {
		return this.bridgeAvailable;
	}

	async autoStart(): Promise<RuntimeStatus> {
		this.autoStartCalls += 1;
		this.statusValue = this.autoStartStatus;
		return this.autoStartStatus;
	}

	async start(): Promise<RuntimeStatus> {
		return makeStatus('running');
	}

	async stop(): Promise<RuntimeStatus> {
		return makeStatus('stopped');
	}

	async restart(): Promise<RuntimeStatus> {
		return makeStatus('restarting');
	}

	async shutdown(): Promise<void> {
		return;
	}

	async status(): Promise<RuntimeStatus | null> {
		this.statusCalls += 1;
		return this.statusValue;
	}

	async preflight() {
		return null;
	}

	async getConfigPath() {
		return null;
	}

	async getLogsPath() {
		return null;
	}

	async listLogProcesses() {
		return [];
	}

	async openConfigPath(): Promise<void> {
		return;
	}

	async openLogsPath(): Promise<void> {
		return;
	}

	async openUserlandUi(): Promise<void> {
		return;
	}

	async getLogsTail() {
		return [];
	}

	async onStatusChanged(listener: (status: RuntimeStatus) => void): Promise<() => void> {
		this.statusListeners.push(listener);
		return () => {
			this.statusListeners = this.statusListeners.filter((entry) => entry !== listener);
		};
	}

	async onRuntimeLog(): Promise<() => void> {
		return () => {};
	}

	emitStatus(status: RuntimeStatus): void {
		this.statusValue = status;
		for (const listener of this.statusListeners) {
			listener(status);
		}
	}
}

function createHarness(options?: {
	runtimePort?: FakeRuntimePort;
	backendProbePort?: BackendProbePort;
	clock?: FakeClock;
	readyTimeoutMs?: number;
	readyPollMs?: number;
	startupRetryWindowMs?: number;
	startupRetryDelayMs?: number;
}) {
	const lifecycleStates: LifecycleState[] = [];
	const errors: Array<string | null> = [];
	const bridgeAvailability: boolean[] = [];
	const runtimePort = options?.runtimePort ?? new FakeRuntimePort();
	const backendProbePort =
		options?.backendProbePort ??
		({
			async probeReady() {
				return;
			}
		} satisfies BackendProbePort);
	const clock = options?.clock ?? new FakeClock();

	const orchestrator = createLifecycleOrchestrator({
		runtimePort,
		backendProbePort,
		desktopShellExpected: true,
		onLifecycleChange: (state) => {
			lifecycleStates.push(state);
		},
		onRuntimeStatus: () => {
			return;
		},
		onBridgeAvailability: (available) => {
			bridgeAvailability.push(available);
		},
		onError: (error) => {
			errors.push(error);
		},
		clock,
		readyTimeoutMs: options?.readyTimeoutMs,
		readyPollMs: options?.readyPollMs,
		startupRetryWindowMs: options?.startupRetryWindowMs,
		startupRetryDelayMs: options?.startupRetryDelayMs
	});

	return {
		orchestrator,
		runtimePort,
		backendProbePort,
		clock,
		lifecycleStates,
		errors,
		bridgeAvailability
	};
}

function eventCodes(states: LifecycleState[]): string[] {
	const latest = states.at(-1);
	if (!latest) {
		return [];
	}
	return latest.events.map((event) => event.code);
}

async function flushMicrotasks(times: number = 10): Promise<void> {
	for (let i = 0; i < times; i += 1) {
		await Promise.resolve();
	}
}

describe('lifecycle orchestrator', () => {
	it('reaches ready on happy path (bridge -> auto-start -> running -> backend probe)', async () => {
		const probeCalls: number[] = [];
		const backendProbePort: BackendProbePort = {
			async probeReady() {
				probeCalls.push(Date.now());
			}
		};
		const runtimePort = new FakeRuntimePort();
		runtimePort.statusValue = makeStatus('running');
		runtimePort.autoStartStatus = makeStatus('running');

		const { orchestrator, lifecycleStates, bridgeAvailability } = createHarness({
			runtimePort,
			backendProbePort
		});

		await orchestrator.autoStart();
		await orchestrator.waitUntilReady();

		expect(orchestrator.isReady()).toBe(true);
		expect(probeCalls).toHaveLength(1);
		expect(bridgeAvailability.at(-1)).toBe(true);
		expect(eventCodes(lifecycleStates)).toContain('runtime.auto_start.accepted');
		expect(eventCodes(lifecycleStates)).toContain('api.request.success');
		expect(eventCodes(lifecycleStates)).toContain('api.ready');
	});

	it('enters fatal when bridge is unavailable and readiness wait rejects', async () => {
		const runtimePort = new FakeRuntimePort();
		runtimePort.loadBridgeResult = false;

		const { orchestrator, lifecycleStates, errors, bridgeAvailability } = createHarness({
			runtimePort
		});

		await orchestrator.init();

		expect(bridgeAvailability.at(-1)).toBe(false);
		expect(errors.at(-1)).toBe('Desktop runtime bridge is unavailable.');
		expect(lifecycleStates.at(-1)?.phase).toBe('fatal');
		await expect(orchestrator.waitUntilReady()).rejects.toThrow(
			'Desktop runtime bridge is unavailable.'
		);
	});

	it('deduplicates concurrent waitUntilReady calls via a single in-flight promise', async () => {
		let resolveProbe!: () => void;
		const probeBarrier = new Promise<void>((resolve) => {
			resolveProbe = () => resolve();
		});
		let probeCalls = 0;
		const backendProbePort: BackendProbePort = {
			async probeReady() {
				probeCalls += 1;
				await probeBarrier;
			}
		};
		const runtimePort = new FakeRuntimePort();
		runtimePort.statusValue = makeStatus('running');
		runtimePort.autoStartStatus = makeStatus('running');

		const { orchestrator } = createHarness({ runtimePort, backendProbePort });

		await orchestrator.autoStart();
		const first = orchestrator.waitUntilReady();
		const second = orchestrator.waitUntilReady();
		await flushMicrotasks();

		expect(probeCalls).toBe(1);
		resolveProbe();
		await Promise.all([first, second]);
		expect(orchestrator.isReady()).toBe(true);
	});

	it('does not auto-start during desktop initialization', async () => {
		const runtimePort = new FakeRuntimePort();
		runtimePort.statusValue = makeStatus('stopped');
		runtimePort.autoStartStatus = makeStatus('stopped');

		const { orchestrator, lifecycleStates } = createHarness({ runtimePort });

		await orchestrator.init();

		expect(runtimePort.autoStartCalls).toBe(0);
		expect(orchestrator.shouldWaitUntilReady()).toBe(false);
		expect(eventCodes(lifecycleStates)).not.toContain('runtime.auto_start.requested');
		expect(eventCodes(lifecycleStates)).not.toContain('ready.poll.start');
	});

	it('does not require readiness polling when runtime is cleanly stopped', async () => {
		const runtimePort = new FakeRuntimePort();
		runtimePort.statusValue = makeStatus('stopped');

		const { orchestrator, lifecycleStates } = createHarness({ runtimePort });

		await orchestrator.waitUntilReady();

		expect(runtimePort.autoStartCalls).toBe(0);
		expect(orchestrator.shouldWaitUntilReady()).toBe(false);
		expect(eventCodes(lifecycleStates)).not.toContain('ready.poll.start');
	});

	it('reports skipped when explicit auto-start returns a clean stopped state', async () => {
		const runtimePort = new FakeRuntimePort();
		runtimePort.statusValue = makeStatus('stopped');
		runtimePort.autoStartStatus = makeStatus('stopped');

		const { orchestrator, lifecycleStates } = createHarness({ runtimePort });

		await orchestrator.autoStart();

		expect(runtimePort.autoStartCalls).toBe(1);
		expect(orchestrator.shouldWaitUntilReady()).toBe(false);
		expect(eventCodes(lifecycleStates)).toContain('runtime.auto_start.skipped');
		expect(eventCodes(lifecycleStates)).not.toContain('ready.poll.start');
	});

	it('retries boot once on fatal -> running transition without background probe loop', async () => {
		const runtimePort = new FakeRuntimePort();
		runtimePort.statusValue = makeStatus('starting');
		let failAutoStart = true;
		runtimePort.autoStart = async () => {
			runtimePort.autoStartCalls += 1;
			if (failAutoStart) {
				failAutoStart = false;
				throw new Error('auto-start failed');
			}
			runtimePort.statusValue = makeStatus('running');
			return runtimePort.statusValue;
		};

		let probeCalls = 0;
		const backendProbePort: BackendProbePort = {
			async probeReady() {
				probeCalls += 1;
			}
		};

		const { orchestrator, lifecycleStates } = createHarness({ runtimePort, backendProbePort });

		await expect(orchestrator.autoStart()).rejects.toThrow('Runtime auto-start failed');
		expect(orchestrator.isReady()).toBe(false);
		expect(lifecycleStates.at(-1)?.phase).toBe('fatal');
		expect(probeCalls).toBe(0);

		runtimePort.emitStatus(makeStatus('running'));
		await flushMicrotasks(20);

		expect(orchestrator.isReady()).toBe(true);
		expect(probeCalls).toBe(1);
		expect(eventCodes(lifecycleStates)).toContain('ready.recover.requested');
		expect(eventCodes(lifecycleStates)).toContain('api.request.success');
	});

	it('enters fatal when runtime does not reach running before timeout', async () => {
		const runtimePort = new FakeRuntimePort();
		runtimePort.statusValue = makeStatus('starting');
		runtimePort.autoStartStatus = makeStatus('starting');

		const { orchestrator, lifecycleStates } = createHarness({
			runtimePort,
			readyTimeoutMs: 900,
			readyPollMs: 300
		});

		await orchestrator.autoStart();
		await expect(orchestrator.waitUntilReady()).rejects.toThrow('did not finish starting in time');
		expect(lifecycleStates.at(-1)?.phase).toBe('fatal');
		expect(eventCodes(lifecycleStates)).toContain('ready.poll.timeout');
	});

	it('cancels an in-flight readiness wait when disposed', async () => {
		let resolveProbe!: () => void;
		const probeBarrier = new Promise<void>((resolve) => {
			resolveProbe = resolve;
		});
		const runtimePort = new FakeRuntimePort();
		runtimePort.statusValue = makeStatus('running');
		runtimePort.autoStartStatus = makeStatus('running');

		const { orchestrator } = createHarness({
			runtimePort,
			backendProbePort: {
				async probeReady() {
					await probeBarrier;
				}
			}
		});

		await orchestrator.autoStart();
		const waitPromise = orchestrator.waitUntilReady();
		await flushMicrotasks(10);
		orchestrator.dispose();
		resolveProbe();
		await expect(waitPromise).rejects.toThrow('Lifecycle readiness wait cancelled');
	});

	it('blocks new readiness polling while lifecycle is stopping', async () => {
		const runtimePort = new FakeRuntimePort();
		runtimePort.statusValue = makeStatus('running');
		runtimePort.autoStartStatus = makeStatus('running');

		const { orchestrator, lifecycleStates } = createHarness({ runtimePort });

		await orchestrator.init();
		orchestrator.setStopping('Stopping runtime processes...', 'runtime.stop.requested');
		await expect(orchestrator.waitUntilReady()).rejects.toThrow(
			'Lifecycle readiness wait cancelled'
		);
		expect(eventCodes(lifecycleStates)).not.toContain('ready.poll.start');
	});
});

function recoveryStatus(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
	return makeStatus('starting', {
		operationId: 1,
		revision: 1,
		startup: {
			phase: STARTUP_PHASES.recovery,
			task: RECOVERY_TASKS.natsMaintenance,
			startedAtMs: 0,
			deadlineAtMs: 900_000
		},
		...overrides
	});
}

describe('supervisor recovery readiness', () => {
	it('waits through long recovery and both backend waits without early probing or duplicate phase events', async () => {
		const clock = new FakeClock();
		const port = new FakeRuntimePort();
		port.statusValue = recoveryStatus();
		const probes: number[] = [];
		port.status = async () => {
			if (clock.nowMs >= 110_000) return makeStatus('running', { operationId: 1, revision: 3 });
			if (clock.nowMs >= 45_000)
				return recoveryStatus({
					revision: 2,
					startup: {
						phase: STARTUP_PHASES.services,
						task: null,
						startedAtMs: 45_000,
						deadlineAtMs: 135_000
					}
				});
			return recoveryStatus();
		};
		const h = createHarness({
			runtimePort: port,
			clock,
			readyPollMs: 1_000,
			backendProbePort: {
				async probeReady() {
					probes.push(clock.nowMs);
				}
			}
		});
		await h.orchestrator.waitUntilReady();
		expect(probes).toEqual([110_000]);
		expect(h.orchestrator.isReady()).toBe(true);
		expect(h.lifecycleStates.some((s) => s.phase === 'fatal')).toBe(false);
		expect(
			eventCodes(h.lifecycleStates).filter((code) => code === STARTUP_PHASE_EVENT_CODE)
		).toHaveLength(2);
	});

	it('attaches using the original deadline and does not renew it on repeated snapshots', async () => {
		const clock = new FakeClock();
		clock.nowMs = 904_000;
		const port = new FakeRuntimePort();
		port.statusValue = recoveryStatus();
		const h = createHarness({ runtimePort: port, clock });
		await expect(h.orchestrator.waitUntilReady()).rejects.toThrow('did not finish starting');
		expect(clock.nowMs).toBeLessThan(906_000);
	});

	it.each([RECOVERY_FAILURE_REASONS.failed, RECOVERY_FAILURE_REASONS.timedOut])(
		'keeps %s terminal and permits a new manual operation',
		async (reason) => {
			const port = new FakeRuntimePort();
			port.statusValue = recoveryStatus();
			const h = createHarness({ runtimePort: port });
			await h.orchestrator.init();
			port.emitStatus(
				makeStatus('stopped', {
					operationId: 1,
					revision: 2,
					lastError: 'private diagnostic',
					recoveryFailure: { task: RECOVERY_TASKS.natsMaintenance, reason }
				})
			);
			await expect(h.orchestrator.waitUntilReady()).rejects.toThrow('retry start');
			expect(h.lifecycleStates.at(-1)?.currentAction).not.toContain('private diagnostic');
			h.orchestrator.beginBoot('Retrying', 'test.retry', 'Retrying');
			port.emitStatus(makeStatus('running', { operationId: 2, revision: 3 }));
			await h.orchestrator.waitUntilReady();
			expect(h.orchestrator.isReady()).toBe(true);
		}
	);

	it('does not let obsolete polls or a stopped operation reopen Userland', async () => {
		const port = new FakeRuntimePort();
		port.statusValue = recoveryStatus();
		const h = createHarness({ runtimePort: port });
		await h.orchestrator.init();
		h.orchestrator.setStopping('Stopping', 'test.stop');
		port.emitStatus(makeStatus('stopped', { operationId: 1, revision: 3 }));
		port.emitStatus(makeStatus('running', { operationId: 1, revision: 2 }));
		expect(h.orchestrator.isReady()).toBe(false);
		expect(h.lifecycleStates.at(-1)?.apiReady).toBe(false);
		h.orchestrator.beginBoot('Retrying', 'test.retry', 'Retrying');
		port.emitStatus(recoveryStatus({ operationId: 2, revision: 4 }));
		h.orchestrator.acceptStatus(recoveryStatus({ operationId: 1, revision: 1 }));
		expect(h.lifecycleStates.at(-1)?.phase).toBe('recovering');
	});

	it('bounds unavailable status during recovery instead of trusting a stale phase forever', async () => {
		const port = new FakeRuntimePort();
		port.statusValue = recoveryStatus();
		const h = createHarness({ runtimePort: port });
		await h.orchestrator.init();
		port.status = async () => null;
		await expect(h.orchestrator.waitUntilReady()).rejects.toThrow('status is unavailable');
		expect(h.lifecycleStates.at(-1)?.phase).toBe('fatal');
	});

	it('bounds a hung status invocation and aborts a hung API probe on Stop', async () => {
		vi.useFakeTimers();
		try {
			const port = new FakeRuntimePort();
			port.statusValue = recoveryStatus();
			const h = createHarness({ runtimePort: port });
			await h.orchestrator.init();
			port.status = () => new Promise(() => {});
			const wait = expect(h.orchestrator.waitUntilReady()).rejects.toThrow('status is unavailable');
			await vi.runAllTimersAsync();
			await wait;
			port.status = async () => makeStatus('running', { operationId: 2, revision: 2 });
			h.orchestrator.dispose();
			const probe = vi.fn(() => new Promise<void>(() => {}));
			const h2 = createHarness({ runtimePort: port, backendProbePort: { probeReady: probe } });
			const cancelled = expect(h2.orchestrator.waitUntilReady()).rejects.toThrow('cancelled');
			await flushMicrotasks(40);
			h2.orchestrator.setStopping('Stopping', 'test.stop');
			await cancelled;
			expect(probe.mock.calls.length).toBe(1);
			expect(h2.orchestrator.isReady()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('requires a new probe after an automatic core restart', async () => {
		const port = new FakeRuntimePort();
		port.statusValue = makeStatus('running', { operationId: 1, revision: 1 });
		let probes = 0;
		const h = createHarness({
			runtimePort: port,
			backendProbePort: {
				async probeReady() {
					probes++;
				}
			}
		});
		await h.orchestrator.waitUntilReady();
		port.emitStatus(recoveryStatus({ state: 'restarting', operationId: 2, revision: 2 }));
		expect(h.orchestrator.isReady()).toBe(false);
		port.emitStatus(makeStatus('running', { operationId: 2, revision: 3 }));
		await h.orchestrator.waitUntilReady();
		expect(probes).toBe(2);
	});
});

it('does not inherit API readiness when all restart phase events were missed', async () => {
	const port = new FakeRuntimePort();
	port.statusValue = makeStatus('running', { operationId: 1, revision: 1 });
	let probes = 0;
	const h = createHarness({
		runtimePort: port,
		backendProbePort: {
			async probeReady() {
				probes++;
			}
		}
	});
	await h.orchestrator.waitUntilReady();
	port.emitStatus(makeStatus('running', { operationId: 2, revision: 8 }));
	expect(h.orchestrator.isReady()).toBe(false);
	await h.orchestrator.waitUntilReady();
	expect(probes).toBe(2);
	expect(h.orchestrator.isReady()).toBe(true);
});
