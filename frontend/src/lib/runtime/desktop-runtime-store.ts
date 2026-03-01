import { browser } from '$app/environment';
import { get, writable } from 'svelte/store';

type RuntimeStatus = {
	state: string;
	restartCount: number;
	lastError: string | null;
	runningProcesses: string[];
	backendHttpBaseUrl: string;
	natsUrl: string;
	configPath: string;
};

type RuntimePreflightCheck = {
	key: string;
	status: 'pass' | 'warn' | 'fail';
	message: string;
};

type RuntimePreflight = {
	ok: boolean;
	checks: RuntimePreflightCheck[];
};

export type RuntimeLogEntry = {
	process: string;
	line: string;
};

export type LifecyclePhase = 'booting' | 'fatal' | 'stopping' | 'ready';
export type LifecycleEventLevel = 'info' | 'warn' | 'error';

export type LifecycleEvent = {
	id: number;
	atIso: string;
	level: LifecycleEventLevel;
	code: string;
	message: string;
	meta?: Record<string, string | number | boolean>;
};

export type LifecycleSession = {
	phase: LifecyclePhase;
	currentAction: string;
	startedAtMs: number;
	operationId: number;
	apiReady: boolean;
	stoppingLockActive: boolean;
	events: LifecycleEvent[];
};

type RuntimeDrawerState = {
	available: boolean;
	initialized: boolean;
	busyAction: string | null;
	status: RuntimeStatus | null;
	preflight: RuntimePreflight | null;
	configPath: string | null;
	logsPath: string | null;
	logs: RuntimeLogEntry[];
	error: string | null;
	lifecycle: LifecycleSession;
};

type TauriApi = {
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
};

const MAX_LOG_LINES = 600;
const LOG_TAIL_LIMIT_PER_PROCESS = 200;
const DEFAULT_LOG_PROCESS = 'desktop-supervisor';
const FRONTEND_BUILD_TARGET =
	(import.meta.env.VITE_FRONTEND_BUILD_TARGET as string | undefined)?.trim() || '';
const IS_DESKTOP_BUILD_TARGET = FRONTEND_BUILD_TARGET === 'desktop';
// Max time to wait for the Tauri JS bridge (`window.__TAURI_INTERNALS__`) during startup.
const TAURI_BRIDGE_INIT_WAIT_MS = 2_000;
// Poll cadence while waiting for the Tauri bridge to become available.
const TAURI_BRIDGE_INIT_POLL_MS = 50;
const LIFECYCLE_EVENT_LIMIT = 200;
// Poll interval while waiting for desktop runtime state to become `running`.
const READY_POLL_INTERVAL_MS = 300;
// Default max wait for desktop runtime readiness before surfacing a startup error.
const READY_TIMEOUT_DEFAULT_MS = 30_000;
const READY_PROGRESS_EVENT_INTERVAL_MS = 1_000;

const DESKTOP_SHELL_EXPECTED = isDesktopShellExpected();

const initialState: RuntimeDrawerState = {
	available: false,
	initialized: false,
	busyAction: null,
	status: null,
	preflight: null,
	configPath: null,
	logsPath: null,
	logs: [],
	error: null,
	lifecycle: createInitialLifecycleSession()
};

function createDesktopRuntimeStore() {
	const state = writable<RuntimeDrawerState>(initialState);

	let statusListener: (() => void) | null = null;
	let logListener: (() => void) | null = null;
	let consoleSessionActive = false;
	let initPromise: Promise<void> | null = null;
	let activeLogProcess = DEFAULT_LOG_PROCESS;
	let logTailRequestToken = 0;
	let lifecycleEventId = 0;

	async function init() {
		if (initPromise) {
			return initPromise;
		}
		initPromise = doInit();
		return initPromise;
	}

	async function doInit() {
		const operationId = beginLifecycleOperation(
			'Initializing desktop runtime...',
			'boot.session.started',
			'Desktop lifecycle session started'
		);
		reportLifecycleEvent('info', 'bridge.waiting', 'Waiting for Tauri bridge to initialize');

		try {
			const tauri = DESKTOP_SHELL_EXPECTED
				? await loadTauriApiWithRetry(TAURI_BRIDGE_INIT_WAIT_MS, TAURI_BRIDGE_INIT_POLL_MS)
				: await loadTauriApi();

			if (!tauri) {
				state.update((snapshot) => ({
					...snapshot,
					available: false,
					initialized: true,
					error: DESKTOP_SHELL_EXPECTED ? 'Desktop runtime bridge is unavailable.' : null
				}));

				if (DESKTOP_SHELL_EXPECTED && isLifecycleOperationActive(operationId)) {
					enterFatal('Desktop runtime bridge is unavailable.', 'bridge.unavailable', {
						maxWaitMs: TAURI_BRIDGE_INIT_WAIT_MS
					});
				}
				return;
			}

			reportLifecycleEvent('info', 'bridge.ready', 'Tauri bridge initialized');
			state.update((snapshot) => ({
				...snapshot,
				available: true
			}));

			if (isLifecycleOperationActive(operationId)) {
				reportLifecycleEvent(
					'info',
					'runtime.auto_start.requested',
					'Requesting runtime auto-start'
				);
				try {
					await tauri.invoke<RuntimeStatus>('runtime_auto_start');
					reportLifecycleEvent(
						'info',
						'runtime.auto_start.accepted',
						'Runtime auto-start command accepted'
					);
				} catch (cause) {
					const message = `Runtime auto-start failed: ${toErrorMessage(cause)}`;
					state.update((snapshot) => ({
						...snapshot,
						initialized: true,
						error: message
					}));
					enterFatal(message, 'runtime.auto_start.failed');
					return;
				}
			}

			await hydrate(tauri, false);
			await ensureStatusListener(tauri);

			state.update((snapshot) => ({
				...snapshot,
				initialized: true,
				error: null
			}));

			if (isLifecycleOperationActive(operationId)) {
				state.update((snapshot) => applyRuntimeStatusToLifecycle(snapshot, snapshot.status));
			}
		} catch (cause) {
			const message = `Failed to initialize desktop runtime store: ${toErrorMessage(cause)}`;
			state.update((snapshot) => ({
				...snapshot,
				initialized: true,
				error: message
			}));
			if (isLifecycleOperationActive(operationId)) {
				enterFatal(message, 'boot.session.failed');
			}
		}
	}

	function dispose() {
		endConsoleSession();
		if (statusListener) {
			statusListener();
			statusListener = null;
		}
		initPromise = null;
		state.set(initialState);
	}

	async function startConsoleSession(process: string = DEFAULT_LOG_PROCESS) {
		await init();
		if (consoleSessionActive) {
			if (process !== activeLogProcess) {
				await setLogProcess(process);
			}
			return;
		}
		const tauri = await loadTauriApi();
		if (!tauri) {
			return;
		}

		activeLogProcess = process;
		await hydrate(tauri, true);
		if (!logListener) {
			logListener = await tauri.listen<RuntimeLogEntry>('runtime-log', (event) => {
				appendLiveLog(event.payload);
			});
		}
		consoleSessionActive = true;
	}

	function endConsoleSession() {
		if (logListener) {
			logListener();
			logListener = null;
		}
		consoleSessionActive = false;
		state.update((snapshot) => ({
			...snapshot,
			logs: []
		}));
	}

	async function setLogProcess(process: string) {
		activeLogProcess = process || DEFAULT_LOG_PROCESS;
		const tauri = await loadTauriApi();
		if (!tauri) {
			return;
		}
		await loadLogTailForActiveProcess(tauri);
	}

	async function start() {
		const operationId = beginLifecycleOperation(
			'Starting local runtime processes...',
			'runtime.start.requested',
			'Runtime start requested from UI'
		);
		await withBusyAction('start', async (tauri) => {
			if (!isLifecycleOperationActive(operationId)) {
				return;
			}
			await tauri.invoke<RuntimeStatus>('runtime_start');
			await hydrate(tauri, consoleSessionActive);
			reportLifecycleEvent('info', 'runtime.start.sent', 'Runtime start command accepted');
		});
	}

	async function stop() {
		setLifecycleStopping('Stopping runtime processes...', 'runtime.stop.requested');
		await withBusyAction('stop', async (tauri) => {
			await tauri.invoke<RuntimeStatus>('runtime_stop');
			await hydrate(tauri, consoleSessionActive);
			reportLifecycleEvent('info', 'runtime.stop.sent', 'Runtime stop command accepted');
		});
	}

	async function restart() {
		const operationId = beginLifecycleOperation(
			'Restarting local runtime processes...',
			'runtime.restart.requested',
			'Runtime restart requested from UI'
		);
		await withBusyAction('restart', async (tauri) => {
			if (!isLifecycleOperationActive(operationId)) {
				return;
			}
			await tauri.invoke<RuntimeStatus>('runtime_restart');
			await hydrate(tauri, consoleSessionActive);
			reportLifecycleEvent('info', 'runtime.restart.sent', 'Runtime restart command accepted');
		});
	}

	async function refreshPreflight() {
		await withBusyAction('preflight', async (tauri) => {
			const preflight = await tauri.invoke<RuntimePreflight>('runtime_preflight');
			state.update((snapshot) => ({
				...snapshot,
				preflight,
				error: null
			}));
		});
	}

	async function openConfigPath() {
		await withBusyAction('openConfig', async (tauri) => {
			await tauri.invoke('runtime_open_config_path');
		});
	}

	async function openLogsPath() {
		await withBusyAction('openLogs', async (tauri) => {
			await tauri.invoke('runtime_open_logs_path');
		});
	}

	function clearLogs() {
		state.update((snapshot) => ({
			...snapshot,
			logs: []
		}));
	}

	async function waitUntilReady(timeoutMs: number = READY_TIMEOUT_DEFAULT_MS): Promise<void> {
		await init();
		const currentSnapshot = get(state);
		if (
			currentSnapshot.status?.state === 'running' &&
			currentSnapshot.lifecycle.phase === 'ready'
		) {
			return;
		}
		const operationId = beginLifecycleOperation(
			'Waiting for runtime readiness...',
			'ready.poll.start',
			'Started runtime readiness polling'
		);

		const tauri = DESKTOP_SHELL_EXPECTED
			? await loadTauriApiWithRetry(TAURI_BRIDGE_INIT_WAIT_MS, TAURI_BRIDGE_INIT_POLL_MS)
			: await loadTauriApi();
		if (!tauri) {
			reportLifecycleEvent(
				'warn',
				'ready.poll.skipped',
				'Tauri bridge unavailable; skipping readiness wait'
			);
			return;
		}

		const timeout = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : READY_TIMEOUT_DEFAULT_MS;
		const deadline = Date.now() + timeout;
		let lastProgressAt = 0;

		while (Date.now() <= deadline) {
			if (!isLifecycleOperationActive(operationId)) {
				return;
			}

			await refreshStatusFromRuntime(tauri);
			const snapshot = get(state);
			const lifecycle = snapshot.lifecycle;
			if (snapshot.status?.state === 'running') {
				reportLifecycleEvent('info', 'ready.poll.running', 'Runtime reported running');
				return;
			}
			if (isFatalRuntimeStatus(snapshot.status)) {
				const fatalMessage =
					snapshot.status?.lastError?.trim() || 'Desktop runtime failed to start';
				enterFatal(fatalMessage, 'ready.poll.fatal');
				throw new Error(fatalMessage);
			}

			const now = Date.now();
			if (now - lastProgressAt >= READY_PROGRESS_EVENT_INTERVAL_MS) {
				reportLifecycleEvent('info', 'ready.poll.tick', 'Waiting for runtime to become ready', {
					state: snapshot.status?.state ?? 'unknown',
					elapsedMs: now - lifecycle.startedAtMs
				});
				lastProgressAt = now;
			}

			await sleep(READY_POLL_INTERVAL_MS);
		}

		const snapshot = get(state);
		const stateLabel = snapshot.status?.state ?? 'unknown';
		reportLifecycleEvent('warn', 'ready.poll.timeout', 'Runtime readiness wait reached timeout', {
			timeoutMs: timeout,
			state: stateLabel
		});
		throw new Error(
			`Desktop runtime did not reach running state within ${timeout}ms (current state: ${stateLabel}).`
		);
	}

	function markApiReady(): void {
		state.update((snapshot) => {
			const lifecycle = snapshot.lifecycle;
			if (lifecycle.apiReady) {
				return snapshot;
			}

			let nextLifecycle: LifecycleSession = {
				...lifecycle,
				apiReady: true
			};
			nextLifecycle = appendLifecycleEvent(nextLifecycle, {
				id: ++lifecycleEventId,
				atIso: new Date().toISOString(),
				level: 'info',
				code: 'api.ready',
				message: 'Backend API responded successfully'
			});

			if (!nextLifecycle.stoppingLockActive && snapshot.status?.state === 'running') {
				nextLifecycle = {
					...nextLifecycle,
					phase: 'ready',
					currentAction: 'Runtime ready',
					startedAtMs: Date.now()
				};
			}

			return {
				...snapshot,
				lifecycle: nextLifecycle
			};
		});
	}

	function reportLifecycleEvent(
		level: LifecycleEventLevel,
		code: string,
		message: string,
		meta?: Record<string, string | number | boolean>
	): void {
		state.update((snapshot) => ({
			...snapshot,
			lifecycle: appendLifecycleEvent(snapshot.lifecycle, {
				id: ++lifecycleEventId,
				atIso: new Date().toISOString(),
				level,
				code,
				message,
				meta
			})
		}));
	}

	function isLifecycleReady(): boolean {
		return get(state).lifecycle.phase === 'ready';
	}

	async function ensureStatusListener(tauri: TauriApi): Promise<void> {
		if (statusListener) {
			return;
		}
		statusListener = await tauri.listen<RuntimeStatus>('runtime-state-changed', (event) => {
			state.update((snapshot) => {
				const previousStatus = snapshot.status;
				const nextSnapshot: RuntimeDrawerState = {
					...snapshot,
					status: event.payload,
					error: null
				};
				return applyRuntimeStatusToLifecycle(nextSnapshot, event.payload, previousStatus);
			});
		});
	}

	async function hydrate(tauri: TauriApi, includeLogTail: boolean) {
		const [status, preflight, configPath, logsPath, logTail] = await Promise.all([
			readRuntimeStatus(tauri),
			readRuntimePreflight(tauri),
			readConfigPath(tauri),
			readLogsPath(tauri),
			includeLogTail ? fetchLogTailForProcess(tauri, activeLogProcess) : Promise.resolve([])
		]);
		state.update((snapshot) => {
			const previousStatus = snapshot.status;
			const nextSnapshot: RuntimeDrawerState = {
				...snapshot,
				status,
				preflight,
				configPath,
				logsPath,
				logs: includeLogTail ? logTail.slice(-MAX_LOG_LINES) : snapshot.logs,
				error: null
			};
			return applyRuntimeStatusToLifecycle(nextSnapshot, status, previousStatus);
		});
	}

	async function refreshStatusFromRuntime(tauri: TauriApi): Promise<void> {
		const status = await readRuntimeStatus(tauri);
		if (!status) {
			return;
		}
		state.update((snapshot) => {
			const previousStatus = snapshot.status;
			const nextSnapshot: RuntimeDrawerState = {
				...snapshot,
				status
			};
			return applyRuntimeStatusToLifecycle(nextSnapshot, status, previousStatus);
		});
	}

	async function withBusyAction(
		action: string,
		run: (tauri: TauriApi) => Promise<void>
	): Promise<void> {
		const tauri = await loadTauriApi();
		if (!tauri) {
			state.update((snapshot) => ({
				...snapshot,
				error: 'Desktop runtime controls are unavailable outside Tauri.'
			}));
			reportLifecycleEvent(
				'error',
				'action.unavailable',
				'Desktop runtime controls are unavailable'
			);
			return;
		}

		state.update((snapshot) => ({
			...snapshot,
			busyAction: action
		}));

		try {
			await run(tauri);
		} catch (cause) {
			const errorMessage = `Runtime action failed: ${toErrorMessage(cause)}`;
			state.update((snapshot) => ({
				...snapshot,
				error: errorMessage
			}));
			reportLifecycleEvent('error', 'action.failed', errorMessage, { action });
		} finally {
			state.update((snapshot) => ({
				...snapshot,
				busyAction: null
			}));
		}
	}

	function appendLiveLog(entry: RuntimeLogEntry) {
		if (entry.process !== activeLogProcess) {
			return;
		}
		state.update((snapshot) => {
			const logs = [...snapshot.logs, entry];
			if (logs.length > MAX_LOG_LINES) {
				logs.splice(0, logs.length - MAX_LOG_LINES);
			}
			return {
				...snapshot,
				logs
			};
		});
	}

	async function loadLogTailForActiveProcess(tauri: TauriApi) {
		const requestToken = ++logTailRequestToken;
		const process = activeLogProcess;
		const logTail = await fetchLogTailForProcess(tauri, process);
		if (requestToken !== logTailRequestToken || process !== activeLogProcess) {
			return;
		}
		state.update((snapshot) => ({
			...snapshot,
			logs: logTail.slice(-MAX_LOG_LINES),
			error: null
		}));
	}

	function beginLifecycleOperation(currentAction: string, code: string, message: string): number {
		let nextOperationId = 0;
		state.update((snapshot) => {
			nextOperationId = snapshot.lifecycle.operationId + 1;
			let lifecycle: LifecycleSession = {
				...snapshot.lifecycle,
				operationId: nextOperationId,
				phase: 'booting',
				currentAction,
				startedAtMs: Date.now(),
				apiReady: false,
				stoppingLockActive: false
			};
			lifecycle = appendLifecycleEvent(lifecycle, {
				id: ++lifecycleEventId,
				atIso: new Date().toISOString(),
				level: 'info',
				code,
				message
			});
			return {
				...snapshot,
				lifecycle
			};
		});
		return nextOperationId;
	}

	function isLifecycleOperationActive(operationId: number): boolean {
		return get(state).lifecycle.operationId === operationId;
	}

	function setLifecycleStopping(currentAction: string, code: string): void {
		state.update((snapshot) => {
			let lifecycle: LifecycleSession = {
				...snapshot.lifecycle,
				phase: 'stopping',
				currentAction,
				startedAtMs: Date.now(),
				stoppingLockActive: true
			};
			lifecycle = appendLifecycleEvent(lifecycle, {
				id: ++lifecycleEventId,
				atIso: new Date().toISOString(),
				level: 'info',
				code,
				message: currentAction
			});
			return {
				...snapshot,
				lifecycle
			};
		});
	}

	function enterFatal(
		message: string,
		code: string,
		meta?: Record<string, string | number | boolean>
	): void {
		state.update((snapshot) => {
			if (snapshot.lifecycle.stoppingLockActive) {
				return snapshot;
			}
			let lifecycle: LifecycleSession = {
				...snapshot.lifecycle,
				phase: 'fatal',
				currentAction: message,
				startedAtMs: Date.now()
			};
			lifecycle = appendLifecycleEvent(lifecycle, {
				id: ++lifecycleEventId,
				atIso: new Date().toISOString(),
				level: 'error',
				code,
				message,
				meta
			});
			return {
				...snapshot,
				lifecycle
			};
		});
	}

	function applyRuntimeStatusToLifecycle(
		snapshot: RuntimeDrawerState,
		status: RuntimeStatus | null,
		previousStatus: RuntimeStatus | null = null
	): RuntimeDrawerState {
		let lifecycle = snapshot.lifecycle;

		if (!status) {
			return snapshot;
		}

		if (lifecycle.stoppingLockActive && status.state !== 'stopping' && status.state !== 'stopped') {
			return snapshot;
		}

		const statusChanged =
			previousStatus?.state !== status.state ||
			previousStatus?.restartCount !== status.restartCount ||
			previousStatus?.lastError !== status.lastError;

		if (status.state === 'stopping') {
			lifecycle = {
				...lifecycle,
				phase: 'stopping',
				currentAction: 'Shutting down local runtime processes...',
				startedAtMs: Date.now(),
				stoppingLockActive: true
			};
			if (statusChanged) {
				lifecycle = appendLifecycleEvent(lifecycle, {
					id: ++lifecycleEventId,
					atIso: new Date().toISOString(),
					level: 'info',
					code: 'runtime.state.stopping',
					message: 'Runtime status changed to stopping'
				});
			}
			return {
				...snapshot,
				lifecycle
			};
		}

		if (status.state === 'stopped' && lifecycle.stoppingLockActive) {
			lifecycle = {
				...lifecycle,
				phase: 'stopping',
				currentAction: 'Runtime stopped. Finalizing shutdown...',
				stoppingLockActive: false
			};
			if (statusChanged) {
				lifecycle = appendLifecycleEvent(lifecycle, {
					id: ++lifecycleEventId,
					atIso: new Date().toISOString(),
					level: 'info',
					code: 'runtime.state.stopped',
					message: 'Runtime status changed to stopped'
				});
			}
			return {
				...snapshot,
				lifecycle
			};
		}

		if (status.state === 'running') {
			lifecycle = {
				...lifecycle,
				phase: lifecycle.apiReady ? 'ready' : 'booting',
				currentAction: lifecycle.apiReady
					? 'Runtime ready'
					: 'Runtime running. Waiting for first backend API response...',
				startedAtMs: lifecycle.apiReady ? Date.now() : lifecycle.startedAtMs,
				stoppingLockActive: false
			};
			if (statusChanged) {
				lifecycle = appendLifecycleEvent(lifecycle, {
					id: ++lifecycleEventId,
					atIso: new Date().toISOString(),
					level: 'info',
					code: 'runtime.state.running',
					message: 'Runtime status changed to running'
				});
			}
			return {
				...snapshot,
				lifecycle
			};
		}

		if (status.state === 'restarting') {
			lifecycle = {
				...lifecycle,
				phase: 'booting',
				currentAction: `Runtime restarting (attempt ${status.restartCount})...`,
				startedAtMs: lifecycle.startedAtMs,
				apiReady: false,
				stoppingLockActive: false
			};
			if (statusChanged) {
				lifecycle = appendLifecycleEvent(lifecycle, {
					id: ++lifecycleEventId,
					atIso: new Date().toISOString(),
					level: 'warn',
					code: 'runtime.state.restarting',
					message: 'Runtime status changed to restarting',
					meta: {
						restartCount: status.restartCount,
						lastError: status.lastError ?? ''
					}
				});
			}
			return {
				...snapshot,
				lifecycle
			};
		}

		if (status.state === 'starting') {
			lifecycle = {
				...lifecycle,
				phase: 'booting',
				currentAction: 'Starting local runtime processes...',
				startedAtMs: lifecycle.startedAtMs,
				apiReady: false,
				stoppingLockActive: false
			};
			if (statusChanged) {
				lifecycle = appendLifecycleEvent(lifecycle, {
					id: ++lifecycleEventId,
					atIso: new Date().toISOString(),
					level: 'info',
					code: 'runtime.state.starting',
					message: 'Runtime status changed to starting'
				});
			}
			return {
				...snapshot,
				lifecycle
			};
		}

		if (status.state === 'stopped' && status.lastError?.trim()) {
			lifecycle = {
				...lifecycle,
				phase: 'fatal',
				currentAction: status.lastError.trim(),
				startedAtMs: Date.now(),
				stoppingLockActive: false
			};
			if (statusChanged) {
				lifecycle = appendLifecycleEvent(lifecycle, {
					id: ++lifecycleEventId,
					atIso: new Date().toISOString(),
					level: 'error',
					code: 'runtime.state.stopped.error',
					message: 'Runtime stopped with error',
					meta: {
						lastError: status.lastError
					}
				});
			}
			return {
				...snapshot,
				lifecycle
			};
		}

		if (status.state === 'stopped') {
			lifecycle = {
				...lifecycle,
				phase: 'booting',
				currentAction: 'Runtime stopped. Waiting for start command...',
				startedAtMs: lifecycle.startedAtMs,
				stoppingLockActive: false
			};
			if (statusChanged) {
				lifecycle = appendLifecycleEvent(lifecycle, {
					id: ++lifecycleEventId,
					atIso: new Date().toISOString(),
					level: 'warn',
					code: 'runtime.state.stopped',
					message: 'Runtime status changed to stopped'
				});
			}
			return {
				...snapshot,
				lifecycle
			};
		}

		return snapshot;
	}

	return {
		state: {
			subscribe: state.subscribe
		},
		init,
		openConsole: startConsoleSession,
		closeConsole: endConsoleSession,
		setLogProcess,
		dispose,
		start,
		stop,
		restart,
		refreshPreflight,
		openConfigPath,
		openLogsPath,
		clearLogs,
		waitUntilReady,
		markApiReady,
		reportLifecycleEvent,
		isLifecycleReady
	};
}

function createInitialLifecycleSession(): LifecycleSession {
	if (DESKTOP_SHELL_EXPECTED) {
		return {
			phase: 'booting',
			currentAction: 'Launching desktop runtime...',
			startedAtMs: Date.now(),
			operationId: 0,
			apiReady: false,
			stoppingLockActive: false,
			events: []
		};
	}

	return {
		phase: 'ready',
		currentAction: 'Web runtime mode',
		startedAtMs: Date.now(),
		operationId: 0,
		apiReady: true,
		stoppingLockActive: false,
		events: []
	};
}

function appendLifecycleEvent(
	lifecycle: LifecycleSession,
	event: LifecycleEvent
): LifecycleSession {
	const events = [...lifecycle.events, event];
	if (events.length > LIFECYCLE_EVENT_LIMIT) {
		events.splice(0, events.length - LIFECYCLE_EVENT_LIMIT);
	}
	return {
		...lifecycle,
		events
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

async function readRuntimeStatus(tauri: TauriApi): Promise<RuntimeStatus | null> {
	return tauri.invoke<RuntimeStatus>('runtime_status').catch(() => null);
}

async function readRuntimePreflight(tauri: TauriApi): Promise<RuntimePreflight | null> {
	return tauri.invoke<RuntimePreflight>('runtime_preflight').catch(() => null);
}

async function readConfigPath(tauri: TauriApi): Promise<string | null> {
	return tauri.invoke<string>('runtime_get_config_path').catch(() => null);
}

async function readLogsPath(tauri: TauriApi): Promise<string | null> {
	return tauri.invoke<string>('runtime_get_logs_path').catch(() => null);
}

async function fetchLogTailForProcess(
	tauri: TauriApi,
	process: string
): Promise<RuntimeLogEntry[]> {
	return tauri
		.invoke<RuntimeLogEntry[]>('runtime_get_logs_tail', {
			process,
			limitPerProcess: LOG_TAIL_LIMIT_PER_PROCESS
		})
		.catch(() => []);
}

async function loadTauriApi(): Promise<TauriApi | null> {
	if (!browser) {
		return null;
	}
	const maybeWindow = window as Window & {
		__TAURI_INTERNALS__?: unknown;
	};
	if (!maybeWindow.__TAURI_INTERNALS__) {
		return null;
	}

	const [{ invoke }, { listen }] = await Promise.all([
		import('@tauri-apps/api/core'),
		import('@tauri-apps/api/event')
	]);
	return { invoke, listen };
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadTauriApiWithRetry(
	maxWaitMs: number,
	pollIntervalMs: number
): Promise<TauriApi | null> {
	const deadline = Date.now() + Math.max(1, maxWaitMs);
	while (Date.now() <= deadline) {
		const tauri = await loadTauriApi();
		if (tauri) {
			return tauri;
		}
		await sleep(Math.max(1, pollIntervalMs));
	}
	return null;
}

function detectDesktopShellLikely(): boolean {
	if (IS_DESKTOP_BUILD_TARGET) {
		return true;
	}
	if (!browser) {
		return false;
	}
	const maybeWindow = window as Window & {
		__TAURI_INTERNALS__?: unknown;
	};
	if (maybeWindow.__TAURI_INTERNALS__) {
		return true;
	}
	const protocol = window.location.protocol.toLowerCase();
	if (protocol === 'tauri:' || protocol === 'asset:') {
		return true;
	}
	const host = window.location.hostname.toLowerCase();
	if (host === 'tauri.localhost' || host.endsWith('.tauri.localhost')) {
		return true;
	}
	return /\btauri\b/i.test(navigator.userAgent);
}

function isDesktopShellExpected(): boolean {
	return IS_DESKTOP_BUILD_TARGET || detectDesktopShellLikely();
}

export const desktopRuntimeStore = createDesktopRuntimeStore();
