import { appendLifecycleEvent, createInitialLifecycleState, reduceLifecycle } from './core/reducer';
import type { LifecycleEventLevel, LifecycleState } from './core/types';
import type { BackendProbePort, ClockPort, RuntimePort, RuntimeStatus } from './ports';

const DEFAULT_BRIDGE_WAIT_MS = 2_000;
const DEFAULT_BRIDGE_POLL_MS = 50;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_POLL_MS = 300;
const DEFAULT_READY_PROGRESS_EVENT_INTERVAL_MS = 1_000;
const DEFAULT_STARTUP_RETRY_WINDOW_MS = 12_000;
const DEFAULT_STARTUP_RETRY_DELAY_MS = 250;

const SYSTEM_EVENT_LIMIT = 200;

type LifecycleOrchestratorOptions = {
	runtimePort: RuntimePort;
	backendProbePort: BackendProbePort;
	desktopShellExpected: boolean;
	onLifecycleChange: (state: LifecycleState) => void;
	onRuntimeStatus: (status: RuntimeStatus | null, previous: RuntimeStatus | null) => void;
	onBridgeAvailability: (available: boolean) => void;
	onError: (error: string | null) => void;
	clock?: ClockPort;
	bridgeWaitMs?: number;
	bridgePollMs?: number;
	readyTimeoutMs?: number;
	readyPollMs?: number;
	readyProgressEventIntervalMs?: number;
	startupRetryWindowMs?: number;
	startupRetryDelayMs?: number;
};

type LifecycleOrchestrator = {
	init(): Promise<void>;
	waitUntilReady(timeoutMs?: number): Promise<void>;
	isReady(): boolean;
	isDesktopShellExpected(): boolean;
	reportEvent(
		level: LifecycleEventLevel,
		code: string,
		message: string,
		meta?: Record<string, string | number | boolean>
	): void;
	markApiReady(): void;
	beginBoot(currentAction: string, code: string, message: string): void;
	setStopping(currentAction: string, code: string): void;
	enterFatal(
		message: string,
		code: string,
		meta?: Record<string, string | number | boolean>
	): void;
	dispose(): void;
};

export function createLifecycleOrchestrator(
	options: LifecycleOrchestratorOptions
): LifecycleOrchestrator {
	const clock: ClockPort = options.clock ?? {
		now: () => Date.now(),
		sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
	};

	const bridgeWaitMs = options.bridgeWaitMs ?? DEFAULT_BRIDGE_WAIT_MS;
	const bridgePollMs = options.bridgePollMs ?? DEFAULT_BRIDGE_POLL_MS;
	const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const readyPollMs = options.readyPollMs ?? DEFAULT_READY_POLL_MS;
	const readyProgressEventIntervalMs =
		options.readyProgressEventIntervalMs ?? DEFAULT_READY_PROGRESS_EVENT_INTERVAL_MS;
	const startupRetryWindowMs = options.startupRetryWindowMs ?? DEFAULT_STARTUP_RETRY_WINDOW_MS;
	const startupRetryDelayMs = options.startupRetryDelayMs ?? DEFAULT_STARTUP_RETRY_DELAY_MS;

	let lifecycle = createInitialLifecycleState(options.desktopShellExpected, clock.now());
	let initPromise: Promise<void> | null = null;
	let initialized = false;
	let readyPromise: Promise<void> | null = null;
	let statusUnlisten: (() => void) | null = null;
	let statusSnapshot: RuntimeStatus | null = null;

	options.onLifecycleChange(lifecycle);

	async function init(): Promise<void> {
		if (initialized) {
			return;
		}
		if (initPromise) {
			return initPromise;
		}
		initPromise = doInit().finally(() => {
			initPromise = null;
		});
		return initPromise;
	}

	async function doInit(): Promise<void> {
		if (!options.desktopShellExpected) {
			initialized = true;
			return;
		}

		beginBoot('Initializing desktop runtime...', 'boot.session.started', 'Desktop lifecycle session started');
		reportEvent('info', 'bridge.waiting', 'Waiting for Tauri bridge to initialize');

		const bridgeAvailable = await options.runtimePort.loadBridge(bridgeWaitMs, bridgePollMs);
		options.onBridgeAvailability(bridgeAvailable);

		if (!bridgeAvailable) {
			const errorMessage = 'Desktop runtime bridge is unavailable.';
			options.onError(errorMessage);
			enterFatal(errorMessage, 'bridge.unavailable', {
				maxWaitMs: bridgeWaitMs
			});
			return;
		}

		reportEvent('info', 'bridge.ready', 'Tauri bridge initialized');
		await ensureStatusListener();
		const latestStatus = await options.runtimePort.status();
		handleStatusChange(latestStatus);

		reportEvent('info', 'runtime.auto_start.requested', 'Requesting runtime auto-start');
		try {
			const startedStatus = await options.runtimePort.autoStart();
			handleStatusChange(startedStatus);
			reportEvent('info', 'runtime.auto_start.accepted', 'Runtime auto-start command accepted');
			options.onError(null);
			initialized = true;
		} catch (error) {
			const message = `Runtime auto-start failed: ${toErrorMessage(error)}`;
			options.onError(message);
			enterFatal(message, 'runtime.auto_start.failed');
		}
	}

	async function ensureStatusListener(): Promise<void> {
		if (statusUnlisten) {
			return;
		}
		statusUnlisten = await options.runtimePort.onStatusChanged((next) => {
			handleStatusChange(next);
		});
	}

	function handleStatusChange(next: RuntimeStatus | null): void {
		const previous = statusSnapshot;
		statusSnapshot = next;
		options.onRuntimeStatus(next, previous);

		if (!next) {
			return;
		}

		const wasFatal = lifecycle.phase === 'fatal';
		dispatch({
			type: 'APPLY_RUNTIME_STATUS',
			status: next,
			previous,
			startedAtMs: clock.now()
		});

		if (
			wasFatal &&
			previous?.state !== 'running' &&
			next.state === 'running' &&
			!readyPromise
		) {
			reportEvent(
				'info',
				'ready.recover.requested',
				'Runtime recovered; retrying backend readiness check once'
			);
			void waitUntilReady().catch(() => {
				// Keep fatal state if retry fails.
			});
		}
	}

	async function waitUntilReady(timeoutMs: number = readyTimeoutMs): Promise<void> {
		if (!options.desktopShellExpected) {
			return;
		}
		await init();

		if (lifecycle.phase === 'ready') {
			return;
		}

		if (readyPromise) {
			return readyPromise;
		}

		readyPromise = doWaitUntilReady(timeoutMs).finally(() => {
			readyPromise = null;
		});
		return readyPromise;
	}

	async function doWaitUntilReady(timeoutMs: number): Promise<void> {
		reportEvent('info', 'ready.poll.start', 'Started runtime readiness polling');

		const timeout = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : readyTimeoutMs;
		const deadline = clock.now() + timeout;
		let lastProgressAt = 0;

		while (clock.now() <= deadline) {
			if (lifecycle.phase === 'fatal') {
				throw new Error(lifecycle.currentAction);
			}

			const status = await options.runtimePort.status();
			handleStatusChange(status);

			if (statusSnapshot?.state === 'running') {
				reportEvent('info', 'ready.poll.running', 'Runtime reported running');
				break;
			}

			if (isFatalRuntimeStatus(statusSnapshot)) {
				const fatalMessage = statusSnapshot?.lastError?.trim() || 'Desktop runtime failed to start';
				enterFatal(fatalMessage, 'ready.poll.fatal');
				throw new Error(fatalMessage);
			}

			const now = clock.now();
			if (now - lastProgressAt >= readyProgressEventIntervalMs) {
				reportEvent('info', 'ready.poll.tick', 'Waiting for runtime to become ready', {
					state: statusSnapshot?.state ?? 'unknown',
					elapsedMs: now - lifecycle.startedAtMs
				});
				lastProgressAt = now;
			}

			await clock.sleep(readyPollMs);
		}

		if (statusSnapshot?.state !== 'running') {
			reportEvent('warn', 'ready.poll.timeout', 'Runtime readiness wait reached timeout', {
				timeoutMs: timeout,
				state: statusSnapshot?.state ?? 'unknown'
			});
			throw new Error(
				`Desktop runtime did not reach running state within ${timeout}ms (current state: ${statusSnapshot?.state ?? 'unknown'}).`
			);
		}

		const probeDeadline = clock.now() + startupRetryWindowMs;
		let attempt = 0;
		for (;;) {
			attempt += 1;
			reportEvent('info', 'api.request.start', 'Sending backend request', {
				attempt
			});
			try {
				await options.backendProbePort.probeReady();
				markApiReady();
				reportEvent('info', 'api.request.success', 'Backend request succeeded', {
					attempt
				});
				options.onError(null);
				return;
			} catch (error) {
				if (clock.now() >= probeDeadline) {
					const message = toErrorMessage(error);
					reportEvent('error', 'api.request.fail.final', 'Backend request failed and will not be retried', {
						attempt,
						message
					});
					enterFatal(message, 'api.request.fail.final');
					throw error;
				}
				reportEvent('warn', 'api.retry', 'Retrying backend request after transient startup failure', {
					attempt,
					retryDelayMs: startupRetryDelayMs
				});
				await clock.sleep(startupRetryDelayMs);
			}
		}
	}

	function isReady(): boolean {
		return lifecycle.phase === 'ready';
	}

	function isDesktopShellExpected(): boolean {
		return options.desktopShellExpected;
	}

	function markApiReady(): void {
		dispatch({
			type: 'API_READY',
			startedAtMs: clock.now()
		});
		reportEvent('info', 'api.ready', 'Backend API responded successfully');
	}

	function beginBoot(currentAction: string, code: string, message: string): void {
		dispatch({
			type: 'BOOT_RESET',
			currentAction,
			startedAtMs: clock.now()
		});
		reportEvent('info', code, message);
	}

	function setStopping(currentAction: string, code: string): void {
		dispatch({
			type: 'SET_STOPPING',
			currentAction,
			startedAtMs: clock.now()
		});
		reportEvent('info', code, currentAction);
	}

	function enterFatal(
		message: string,
		code: string,
		meta?: Record<string, string | number | boolean>
	): void {
		if (lifecycle.stoppingLockActive) {
			return;
		}
		dispatch({
			type: 'SET_FATAL',
			currentAction: message,
			startedAtMs: clock.now()
		});
		reportEvent('error', code, message, meta);
	}

	function reportEvent(
		level: LifecycleEventLevel,
		code: string,
		message: string,
		meta?: Record<string, string | number | boolean>
	): void {
		lifecycle = appendLifecycleEvent(
			lifecycle,
			{
				id: -1,
				atIso: new Date(clock.now()).toISOString(),
				level,
				code,
				message,
				meta
			},
			SYSTEM_EVENT_LIMIT
		);
		options.onLifecycleChange(lifecycle);
	}

	function dispatch(action: Parameters<typeof reduceLifecycle>[1]): void {
		lifecycle = reduceLifecycle(lifecycle, action, {
			eventLimit: SYSTEM_EVENT_LIMIT
		});
		options.onLifecycleChange(lifecycle);
	}

	function dispose(): void {
		if (statusUnlisten) {
			statusUnlisten();
			statusUnlisten = null;
		}
	}

	return {
		init,
		waitUntilReady,
		isReady,
		isDesktopShellExpected,
		reportEvent,
		markApiReady,
		beginBoot,
		setStopping,
		enterFatal,
		dispose
	};
}

function isFatalRuntimeStatus(status: RuntimeStatus | null): boolean {
	if (!status) {
		return false;
	}
	if (status.state !== 'stopped') {
		return false;
	}
	return Boolean(status.lastError?.trim());
}

function toErrorMessage(value: unknown): string {
	if (value instanceof Error && value.message.trim()) {
		return value.message;
	}
	if (typeof value === 'string' && value.trim()) {
		return value;
	}
	return 'unknown error';
}
