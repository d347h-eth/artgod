import { writable } from 'svelte/store';
import { createInitialLifecycleState } from './lifecycle/core/reducer';
import type { LifecycleEventLevel, LifecycleState } from './lifecycle/core/types';
import { createBackendProbePort } from './lifecycle/adapters/backend-probe-port';
import {
	IS_DESKTOP_BUILD_TARGET,
	isDesktopShellExpected
} from './lifecycle/adapters/desktop-shell';
import { createTauriRuntimePort } from './lifecycle/adapters/tauri-runtime-port';
import { createLifecycleOrchestrator } from './lifecycle/orchestrator';
import type { RuntimeLogEntry, RuntimePreflight, RuntimeStatus } from './lifecycle/ports';

export type { LifecycleEventLevel } from './lifecycle/core/types';
export type { RuntimeLogEntry } from './lifecycle/ports';

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
	lifecycle: LifecycleState;
};

const MAX_LOG_LINES = 600;
const LOG_TAIL_LIMIT_PER_PROCESS = 200;
const DEFAULT_LOG_PROCESS = 'desktop-supervisor';

// Max time to wait for the Tauri JS bridge (`window.__TAURI_INTERNALS__`) during startup.
const TAURI_BRIDGE_INIT_WAIT_MS = 2_000;
// Poll cadence while waiting for the Tauri bridge to become available.
const TAURI_BRIDGE_INIT_POLL_MS = 50;

// Default max wait for desktop runtime readiness before surfacing a startup error.
const READY_TIMEOUT_DEFAULT_MS = 30_000;

const DESKTOP_SHELL_EXPECTED = isDesktopShellExpected();

function createDesktopRuntimeStore() {
	const runtimePort = createTauriRuntimePort();
	const backendProbePort = createBackendProbePort();

	const initialLifecycle = createInitialLifecycleState(DESKTOP_SHELL_EXPECTED, Date.now());
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
		lifecycle: initialLifecycle
	};

	const state = writable<RuntimeDrawerState>(initialState);

	const lifecycle = createLifecycleOrchestrator({
		runtimePort,
		backendProbePort,
		desktopShellExpected: DESKTOP_SHELL_EXPECTED,
		onLifecycleChange: (nextLifecycle) => {
			state.update((snapshot) => ({
				...snapshot,
				lifecycle: nextLifecycle
			}));
		},
		onRuntimeStatus: (status) => {
			state.update((snapshot) => ({
				...snapshot,
				status,
				error: status ? null : snapshot.error
			}));
		},
		onBridgeAvailability: (available) => {
			state.update((snapshot) => ({
				...snapshot,
				available
			}));
		},
		onError: (error) => {
			state.update((snapshot) => ({
				...snapshot,
				error
			}));
		}
	});

	let logListener: (() => void) | null = null;
	let consoleSessionActive = false;
	let initPromise: Promise<void> | null = null;
	let activeLogProcess = DEFAULT_LOG_PROCESS;
	let logTailRequestToken = 0;

	async function init(): Promise<void> {
		if (initPromise) {
			return initPromise;
		}
		initPromise = doInit().finally(() => {
			initPromise = null;
		});
		return initPromise;
	}

	async function doInit(): Promise<void> {
		try {
			await lifecycle.init();
			if (lifecycle.isDesktopShellExpected()) {
				void lifecycle.waitUntilReady().catch(() => {
					// Fatal state is exposed in lifecycle events and overlay.
				});
			}
			if (runtimePort.isBridgeAvailable()) {
				await hydrate(false);
			}
			state.update((snapshot) => ({
				...snapshot,
				available: runtimePort.isBridgeAvailable(),
				initialized: true,
				error: snapshot.error
			}));
		} catch (cause) {
			const message = `Failed to initialize desktop runtime store: ${toErrorMessage(cause)}`;
			state.update((snapshot) => ({
				...snapshot,
				initialized: true,
				error: message
			}));
			lifecycle.enterFatal(message, 'boot.session.failed');
		}
	}

	function dispose() {
		endConsoleSession();
		lifecycle.dispose();
	}

	async function startConsoleSession(process: string = DEFAULT_LOG_PROCESS) {
		await init();
		if (consoleSessionActive) {
			if (process !== activeLogProcess) {
				await setLogProcess(process);
			}
			return;
		}
		if (!runtimePort.isBridgeAvailable()) {
			return;
		}

		activeLogProcess = process;
		await hydrate(true);
		if (!logListener) {
			logListener = await runtimePort.onRuntimeLog((entry) => {
				appendLiveLog(entry);
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
		if (!runtimePort.isBridgeAvailable()) {
			return;
		}
		await loadLogTailForActiveProcess();
	}

	async function start() {
		lifecycle.beginBoot(
			'Starting local runtime processes...',
			'runtime.start.requested',
			'Runtime start requested from UI'
		);
		await withBusyAction('start', async () => {
			await runtimePort.start();
			await hydrate(consoleSessionActive);
			lifecycle.reportEvent('info', 'runtime.start.sent', 'Runtime start command accepted');
		});
	}

	async function stop() {
		lifecycle.setStopping('Stopping runtime processes...', 'runtime.stop.requested');
		await withBusyAction('stop', async () => {
			await runtimePort.stop();
			await hydrate(consoleSessionActive);
			lifecycle.reportEvent('info', 'runtime.stop.sent', 'Runtime stop command accepted');
		});
	}

	async function restart() {
		lifecycle.beginBoot(
			'Restarting local runtime processes...',
			'runtime.restart.requested',
			'Runtime restart requested from UI'
		);
		await withBusyAction('restart', async () => {
			await runtimePort.restart();
			await hydrate(consoleSessionActive);
			lifecycle.reportEvent('info', 'runtime.restart.sent', 'Runtime restart command accepted');
		});
	}

	async function refreshPreflight() {
		await withBusyAction('preflight', async () => {
			const preflight = await runtimePort.preflight();
			state.update((snapshot) => ({
				...snapshot,
				preflight,
				error: null
			}));
		});
	}

	async function openConfigPath() {
		await withBusyAction('openConfig', async () => {
			await runtimePort.openConfigPath();
		});
	}

	async function openLogsPath() {
		await withBusyAction('openLogs', async () => {
			await runtimePort.openLogsPath();
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
		await lifecycle.waitUntilReady(timeoutMs);
	}

	function markApiReady(): void {
		lifecycle.markApiReady();
	}

	function reportLifecycleEvent(
		level: LifecycleEventLevel,
		code: string,
		message: string,
		meta?: Record<string, string | number | boolean>
	): void {
		lifecycle.reportEvent(level, code, message, meta);
	}

	function isLifecycleReady(): boolean {
		return lifecycle.isReady();
	}

	async function hydrate(includeLogTail: boolean) {
		const [status, preflight, configPath, logsPath, logTail] = await Promise.all([
			runtimePort.status(),
			runtimePort.preflight(),
			runtimePort.getConfigPath(),
			runtimePort.getLogsPath(),
			includeLogTail
				? runtimePort.getLogsTail(activeLogProcess, LOG_TAIL_LIMIT_PER_PROCESS)
				: Promise.resolve([])
		]);

		state.update((snapshot) => ({
			...snapshot,
			status,
			preflight,
			configPath,
			logsPath,
			logs: includeLogTail ? logTail.slice(-MAX_LOG_LINES) : snapshot.logs,
			error: null
		}));
	}

	async function withBusyAction(action: string, run: () => Promise<void>): Promise<void> {
		const bridgeAvailable =
			runtimePort.isBridgeAvailable() ||
			(await runtimePort.loadBridge(TAURI_BRIDGE_INIT_WAIT_MS, TAURI_BRIDGE_INIT_POLL_MS));
		if (!bridgeAvailable) {
			const error = 'Desktop runtime controls are unavailable outside Tauri.';
			state.update((snapshot) => ({
				...snapshot,
				error
			}));
			lifecycle.reportEvent('error', 'action.unavailable', 'Desktop runtime controls are unavailable');
			return;
		}

		state.update((snapshot) => ({
			...snapshot,
			busyAction: action
		}));

		try {
			await run();
		} catch (cause) {
			const errorMessage = `Runtime action failed: ${toErrorMessage(cause)}`;
			state.update((snapshot) => ({
				...snapshot,
				error: errorMessage
			}));
			lifecycle.reportEvent('error', 'action.failed', errorMessage, { action });
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

	async function loadLogTailForActiveProcess() {
		const requestToken = ++logTailRequestToken;
		const process = activeLogProcess;
		const logTail = await runtimePort.getLogsTail(process, LOG_TAIL_LIMIT_PER_PROCESS);
		if (requestToken !== logTailRequestToken || process !== activeLogProcess) {
			return;
		}
		state.update((snapshot) => ({
			...snapshot,
			logs: logTail.slice(-MAX_LOG_LINES),
			error: null
		}));
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

function toErrorMessage(value: unknown): string {
	if (value instanceof Error && value.message.trim()) {
		return value.message;
	}
	if (typeof value === 'string' && value.trim()) {
		return value;
	}
	return 'unknown error';
}

export const desktopRuntimeStore = createDesktopRuntimeStore();

export { IS_DESKTOP_BUILD_TARGET };
