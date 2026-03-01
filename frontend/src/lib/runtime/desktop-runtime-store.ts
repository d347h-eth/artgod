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
};

type TauriApi = {
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
};

const MAX_LOG_LINES = 600;
const LOG_TAIL_LIMIT_PER_PROCESS = 200;
const DEFAULT_LOG_PROCESS = 'desktop-supervisor';
// Poll interval while waiting for desktop runtime state to become `running`.
const READY_POLL_INTERVAL_MS = 300;
// Default max wait for desktop runtime readiness before surfacing a startup error.
const READY_TIMEOUT_DEFAULT_MS = 30_000;

const initialState: RuntimeDrawerState = {
	available: false,
	initialized: false,
	busyAction: null,
	status: null,
	preflight: null,
	configPath: null,
	logsPath: null,
	logs: [],
	error: null
};

function createDesktopRuntimeStore() {
	const state = writable<RuntimeDrawerState>(initialState);

	let statusListener: (() => void) | null = null;
	let logListener: (() => void) | null = null;
	let consoleSessionActive = false;
	let initPromise: Promise<void> | null = null;
	let activeLogProcess = DEFAULT_LOG_PROCESS;
	let logTailRequestToken = 0;

	async function init() {
		if (initPromise) {
			return initPromise;
		}
		initPromise = doInit();
		return initPromise;
	}

	async function doInit() {
		try {
			const tauri = await loadTauriApi();
			if (!tauri) {
				state.update((snapshot) => ({
					...snapshot,
					available: false,
					initialized: true
				}));
				return;
			}

			state.update((snapshot) => ({
				...snapshot,
				available: true
			}));

			await hydrate(tauri, false);
			await ensureStatusListener(tauri);

			state.update((snapshot) => ({
				...snapshot,
				initialized: true,
				error: null
			}));
		} catch (cause) {
			state.update((snapshot) => ({
				...snapshot,
				initialized: true,
				error: `Failed to initialize desktop runtime store: ${toErrorMessage(cause)}`
			}));
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
		await withBusyAction('start', async (tauri) => {
			await tauri.invoke<RuntimeStatus>('runtime_start');
			await hydrate(tauri, consoleSessionActive);
		});
	}

	async function stop() {
		await withBusyAction('stop', async (tauri) => {
			await tauri.invoke<RuntimeStatus>('runtime_stop');
			await hydrate(tauri, consoleSessionActive);
		});
	}

	async function restart() {
		await withBusyAction('restart', async (tauri) => {
			await tauri.invoke<RuntimeStatus>('runtime_restart');
			await hydrate(tauri, consoleSessionActive);
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
		const tauri = await loadTauriApi();
		if (!tauri) {
			return;
		}

		const timeout = Number.isFinite(timeoutMs) ? Math.max(1, timeoutMs) : READY_TIMEOUT_DEFAULT_MS;
		const deadline = Date.now() + timeout;

		while (Date.now() <= deadline) {
			await refreshStatusFromRuntime(tauri);
			const snapshot = get(state);
			if (snapshot.status?.state === 'running') {
				return;
			}
			if (isFatalRuntimeStatus(snapshot.status)) {
				throw new Error(snapshot.status?.lastError?.trim() || 'Desktop runtime failed to start');
			}
			await sleep(READY_POLL_INTERVAL_MS);
		}

		const snapshot = get(state);
		const stateLabel = snapshot.status?.state ?? 'unknown';
		throw new Error(
			`Desktop runtime did not reach running state within ${timeout}ms (current state: ${stateLabel}).`
		);
	}

	async function ensureStatusListener(tauri: TauriApi): Promise<void> {
		if (statusListener) {
			return;
		}
		statusListener = await tauri.listen<RuntimeStatus>('runtime-state-changed', (event) => {
			state.update((snapshot) => ({
				...snapshot,
				status: event.payload,
				error: null
			}));
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

	async function refreshStatusFromRuntime(tauri: TauriApi): Promise<void> {
		const status = await readRuntimeStatus(tauri);
		if (!status) {
			return;
		}
		state.update((snapshot) => ({
			...snapshot,
			status
		}));
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
			return;
		}

		state.update((snapshot) => ({
			...snapshot,
			busyAction: action
		}));

		try {
			await run(tauri);
		} catch (cause) {
			state.update((snapshot) => ({
				...snapshot,
				error: `Runtime action failed: ${toErrorMessage(cause)}`
			}));
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
		waitUntilReady
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

export const desktopRuntimeStore = createDesktopRuntimeStore();
