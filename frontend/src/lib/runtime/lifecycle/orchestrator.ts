import { appendLifecycleEvent, createInitialLifecycleState, reduceLifecycle } from './core/reducer';
import type { LifecycleEventLevel, LifecycleState } from './core/types';
import { runtimeFailureMessage } from './core/startup-presentation';
import type { BackendProbePort, ClockPort, RuntimePort, RuntimeStatus } from './ports';

const DEFAULT_BRIDGE_WAIT_MS = 2_000;
const DEFAULT_BRIDGE_POLL_MS = 50;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_READY_POLL_MS = 300;
const DEFAULT_READY_PROGRESS_EVENT_INTERVAL_MS = 1_000;
const DEFAULT_STARTUP_RETRY_WINDOW_MS = 12_000;
const DEFAULT_STARTUP_RETRY_DELAY_MS = 250;
// Status polling must remain bounded even when a bridge invocation never settles.
const STATUS_REQUEST_TIMEOUT_MS = 2_000;
const STATUS_UNAVAILABLE_TIMEOUT_MS = 5_000;
// Gives the next authoritative phase/cleanup snapshot time to cross the bridge.
const PHASE_RECONCILIATION_ALLOWANCE_MS = 5_000;

const READY_WAIT_CANCELLED_ERROR = 'Lifecycle readiness wait cancelled';
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
	acceptStatus(status: RuntimeStatus | null): void;
	refreshStatus(): Promise<void>;
	init(): Promise<void>;
	autoStart(): Promise<RuntimeStatus | null>;
	waitUntilReady(timeoutMs?: number): Promise<void>;
	shouldWaitUntilReady(): boolean;
	isReady(): boolean;
	isDesktopShellExpected(): boolean;
	reportEvent(
		level: LifecycleEventLevel,
		code: string,
		message: string,
		meta?: Record<string, string | number | boolean>
	): void;
	beginBoot(currentAction: string, code: string, message: string): void;
	setStopping(currentAction: string, code: string): void;
	enterFatal(message: string, code: string, meta?: Record<string, string | number | boolean>): void;
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
	let readyPromiseOperationId: number | null = null;
	let readyOperationSequence = 0;
	let activeReadyOperationId: number | null = null;
	let statusUnlisten: (() => void) | null = null;
	let statusSnapshot: RuntimeStatus | null = null;
	let disposed = false;
	let readyAbort: AbortController | null = null;
	let stopRequestedByUi = false;
	let lastConfirmedStatusAt = clock.now();

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

		beginBoot(
			'Initializing desktop runtime...',
			'boot.session.started',
			'Desktop lifecycle session started'
		);
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
		await refreshStatus();
		options.onError(null);
		initialized = true;
	}

	async function autoStart(): Promise<RuntimeStatus | null> {
		if (!options.desktopShellExpected) {
			return null;
		}

		await init();
		if (!options.runtimePort.isBridgeAvailable()) {
			const message = 'Desktop runtime bridge is unavailable.';
			options.onError(message);
			enterFatal(message, 'bridge.unavailable');
			throw new Error(message);
		}

		reportEvent('info', 'runtime.auto_start.requested', 'Requesting runtime auto-start');
		try {
			const startedStatus = await options.runtimePort.autoStart();
			handleStatusChange(startedStatus);
			if (isStoppedWithoutError(startedStatus)) {
				reportEvent('info', 'runtime.auto_start.skipped', 'Runtime auto-start is disabled');
			} else {
				reportEvent('info', 'runtime.auto_start.accepted', 'Runtime auto-start command accepted');
			}
			options.onError(null);
			return startedStatus;
		} catch (error) {
			const message = `Runtime auto-start failed: ${toErrorMessage(error)}`;
			options.onError(message);
			enterFatal(message, 'runtime.auto_start.failed');
			throw new Error(message);
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
		if (disposed || !next) return;
		if (stopRequestedByUi && next.state !== 'stopped' && next.state !== 'stopping') return;
		const previous = statusSnapshot;
		const generationChanged = previous !== null && previous.operationId !== next.operationId;
		// Events and IPC responses share the supervisor's revision order. A slow poll
		// cannot overwrite a newer phase, completed retry, or shutdown snapshot.
		if (previous && next.revision > 0 && previous.revision > 0) {
			if (next.revision < previous.revision || next.operationId < previous.operationId) return;
			lastConfirmedStatusAt = clock.now();
			if (next.revision === previous.revision) return;
		}
		lastConfirmedStatusAt = clock.now();
		statusSnapshot = next;
		options.onRuntimeStatus(next, previous);

		const wasFatal = lifecycle.phase === 'fatal';
		dispatch({
			type: 'APPLY_RUNTIME_STATUS',
			status: next,
			previous,
			startedAtMs: clock.now()
		});
		if (generationChanged || (previous?.state === 'running' && next.state !== 'running')) {
			cancelReadyOperation();
		}
		if (
			!stopRequestedByUi &&
			!readyPromise &&
			(next.state === 'restarting' ||
				(generationChanged && next.state === 'starting') ||
				((generationChanged || previous?.state !== 'running') &&
					next.state === 'running' &&
					!wasFatal))
		) {
			void waitUntilReady().catch(() => {});
		}

		if (wasFatal && previous?.state !== 'running' && next.state === 'running' && !readyPromise) {
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

	async function refreshStatus(): Promise<void> {
		const next = await boundedCall(options.runtimePort.status(), STATUS_REQUEST_TIMEOUT_MS);
		if (!next) throw new Error('Runtime status is unavailable.');
		handleStatusChange(next);
	}

	async function waitUntilReady(timeoutMs: number = readyTimeoutMs): Promise<void> {
		if (!options.desktopShellExpected) {
			return;
		}
		await init();

		if (isLifecycleStopping(lifecycle)) {
			throw new Error(READY_WAIT_CANCELLED_ERROR);
		}

		if (lifecycle.phase === 'ready') {
			return;
		}

		if (readyPromise) {
			return readyPromise;
		}

		if (isStoppedWithoutError(statusSnapshot)) {
			return;
		}

		const operationId = beginReadyOperation();
		readyPromiseOperationId = operationId;
		readyPromise = doWaitUntilReady(timeoutMs, operationId).finally(() => {
			if (readyPromiseOperationId === operationId) {
				readyPromise = null;
				readyPromiseOperationId = null;
			}
		});
		return readyPromise;
	}

	function beginReadyOperation(): number {
		readyAbort = new AbortController();
		readyOperationSequence += 1;
		activeReadyOperationId = readyOperationSequence;
		return readyOperationSequence;
	}

	function cancelReadyOperation(): void {
		readyAbort?.abort();
		readyAbort = null;
		readyOperationSequence += 1;
		activeReadyOperationId = null;
		readyPromise = null;
		readyPromiseOperationId = null;
	}

	function assertReadyOperationActive(operationId: number): void {
		if (disposed || activeReadyOperationId !== operationId) {
			throw new Error(READY_WAIT_CANCELLED_ERROR);
		}
	}

	async function doWaitUntilReady(timeoutMs: number, operationId: number): Promise<void> {
		reportEvent('info', 'ready.poll.start', 'Started runtime readiness polling');
		if (isLifecycleFatal(lifecycle)) {
			throw new Error(lifecycle.currentAction);
		}

		const timeout = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : readyTimeoutMs;
		const fallbackDeadline = clock.now() + timeout;
		let lastProgressAt = clock.now();
		let phaseKey: string | null = null;
		let phaseDeadline = fallbackDeadline;
		const signal = readyAbort!.signal;

		while (statusSnapshot?.state !== 'running') {
			assertReadyOperationActive(operationId);
			if (isLifecycleFatal(lifecycle)) throw new Error(lifecycle.currentAction);
			try {
				const next = await boundedCall(
					options.runtimePort.status(),
					STATUS_REQUEST_TIMEOUT_MS,
					signal
				);
				assertReadyOperationActive(operationId);
				handleStatusChange(next);
			} catch (error) {
				assertReadyOperationActive(operationId);
				// Keep the last known phase only for a short bridge outage.
			}
			assertReadyOperationActive(operationId);
			if (clock.now() - lastConfirmedStatusAt >= STATUS_UNAVAILABLE_TIMEOUT_MS) {
				const message = 'Runtime status is unavailable. Open logs or stop infra, then retry start.';
				enterFatal(message, 'ready.status.unavailable');
				throw new Error(message);
			}
			if (isFatalRuntimeStatus(statusSnapshot)) {
				const message = runtimeFailureMessage(statusSnapshot!);
				enterFatal(message, 'ready.poll.fatal');
				throw new Error(message);
			}
			if (statusSnapshot?.state === 'stopped') return;
			if (statusSnapshot?.state === 'running') break;

			const activity = statusSnapshot?.startup;
			if (activity) {
				const key = `${statusSnapshot!.operationId}:${activity.phase}:${activity.startedAtMs}`;
				if (key !== phaseKey) {
					phaseKey = key;
					// Absolute supervisor timestamps survive repeated polls and UI reloads.
					phaseDeadline = activity.deadlineAtMs + PHASE_RECONCILIATION_ALLOWANCE_MS;
				}
			}
			const now = clock.now();
			if (now >= phaseDeadline) {
				const message =
					'Local services did not finish starting in time. Open logs or stop infra, then retry start.';
				enterFatal(message, 'ready.poll.timeout', { state: statusSnapshot?.state ?? 'unknown' });
				throw new Error(message);
			}
			if (now - lastProgressAt >= readyProgressEventIntervalMs) {
				// Phase transitions carry useful progress; avoid one log row per second
				// throughout a long maintenance task.
				if (!activity)
					reportEvent('info', 'ready.poll.tick', 'Waiting for runtime to become ready', {
						state: statusSnapshot?.state ?? 'unknown',
						elapsedMs: now - lifecycle.startedAtMs
					});
				lastProgressAt = now;
			}
			await clock.sleep(readyPollMs);
		}

		assertReadyOperationActive(operationId);
		reportEvent('info', 'ready.poll.running', 'Runtime reported running');

		const probeDeadline = clock.now() + startupRetryWindowMs;
		const runtimeOperationId = statusSnapshot?.operationId;
		let attempt = 0;
		for (;;) {
			assertReadyOperationActive(operationId);

			attempt += 1;
			reportEvent('info', 'api.request.start', 'Sending backend request', {
				attempt
			});
			try {
				await boundedCall(
					options.backendProbePort.probeReady(signal),
					Math.max(1, probeDeadline - clock.now()),
					signal
				);
				assertReadyOperationActive(operationId);
				// Reconcile even when the restart event was missed during the API request.
				const confirmed = await boundedCall(
					options.runtimePort.status(),
					STATUS_REQUEST_TIMEOUT_MS,
					signal
				);
				assertReadyOperationActive(operationId);
				if (!confirmed) throw new Error('Runtime status is unavailable.');
				handleStatusChange(confirmed);
				assertReadyOperationActive(operationId);
				if (
					statusSnapshot?.state !== 'running' ||
					statusSnapshot.operationId !== runtimeOperationId
				) {
					throw new Error(READY_WAIT_CANCELLED_ERROR);
				}
				if (clock.now() >= probeDeadline) throw new Error('Backend readiness probe timed out.');
				markApiReady();
				reportEvent('info', 'api.request.success', 'Backend request succeeded', {
					attempt
				});
				options.onError(null);
				return;
			} catch (error) {
				assertReadyOperationActive(operationId);

				if (clock.now() >= probeDeadline) {
					const message = toErrorMessage(error);
					reportEvent(
						'error',
						'api.request.fail.final',
						'Backend request failed and will not be retried',
						{
							attempt,
							message
						}
					);
					enterFatal(
						'Local services are not responding. Open logs or stop infra, then retry start.',
						'api.request.fail.final'
					);
					readyAbort?.abort();
					throw error;
				}
				reportEvent(
					'warn',
					'api.retry',
					'Retrying backend request after transient startup failure',
					{
						attempt,
						retryDelayMs: startupRetryDelayMs
					}
				);
				await clock.sleep(startupRetryDelayMs);
			}
		}
	}

	function isReady(): boolean {
		return lifecycle.phase === 'ready';
	}

	function shouldWaitUntilReady(): boolean {
		if (!options.desktopShellExpected) {
			return false;
		}
		return !isStoppedWithoutError(statusSnapshot);
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
		stopRequestedByUi = false;
		cancelReadyOperation();
		dispatch({
			type: 'BOOT_RESET',
			currentAction,
			startedAtMs: clock.now()
		});
		reportEvent('info', code, message);
	}

	function setStopping(currentAction: string, code: string): void {
		stopRequestedByUi = true;
		cancelReadyOperation();
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
		disposed = true;
		cancelReadyOperation();
		if (statusUnlisten) {
			statusUnlisten();
			statusUnlisten = null;
		}
	}

	return {
		acceptStatus: handleStatusChange,
		refreshStatus,
		init,
		autoStart,
		waitUntilReady,
		shouldWaitUntilReady,
		isReady,
		isDesktopShellExpected,
		reportEvent,
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

function isStoppedWithoutError(status: RuntimeStatus | null): boolean {
	return status?.state === 'stopped' && !status.lastError?.trim();
}

function isLifecycleFatal(state: LifecycleState): boolean {
	return state.phase === 'fatal';
}

function isLifecycleStopping(state: LifecycleState): boolean {
	return state.phase === 'stopping';
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

/** A hung IPC/fetch never owns the lifecycle. Underlying late results are ignored. */
function boundedCall<T>(work: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(
			() => finish(() => reject(new Error('Runtime request timed out.'))),
			timeoutMs
		);
		const abort = () => finish(() => reject(new Error(READY_WAIT_CANCELLED_ERROR)));
		function finish(settle: () => void) {
			clearTimeout(timer);
			signal?.removeEventListener('abort', abort);
			settle();
		}
		signal?.addEventListener('abort', abort, { once: true });
		if (signal?.aborted) abort();
		work.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error))
		);
	});
}
