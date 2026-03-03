import { describe, expect, it } from 'vitest';

import { createLifecycleOrchestrator } from './orchestrator';
import type { BackendProbePort, RuntimePort, RuntimeStatus } from './ports';
import type { LifecycleState } from './core/types';

function makeStatus(state: string, overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
	return {
		state,
		restartCount: 0,
		lastError: null,
		runningProcesses: [],
		backendHttpBaseUrl: 'http://127.0.0.1:3000',
		natsUrl: 'nats://127.0.0.1:4222',
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

		const first = orchestrator.waitUntilReady();
		const second = orchestrator.waitUntilReady();
		await flushMicrotasks();

		expect(probeCalls).toBe(1);
		resolveProbe();
		await Promise.all([first, second]);
		expect(orchestrator.isReady()).toBe(true);
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

		await expect(orchestrator.waitUntilReady()).rejects.toThrow('Runtime auto-start failed');
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

		await expect(orchestrator.waitUntilReady()).rejects.toThrow('did not reach running state');
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
