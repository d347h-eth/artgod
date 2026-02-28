import { browser } from '$app/environment';
import { writable } from 'svelte/store';

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

	let listeners: Array<() => void> = [];
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

		state.update((snapshot) => ({
			...snapshot,
			initialized: true
		}));
	}

	function dispose() {
		endConsoleSession();
		initPromise = null;
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

		const unlistenState = await tauri.listen<RuntimeStatus>('runtime-state-changed', (event) => {
			state.update((snapshot) => ({
				...snapshot,
				status: event.payload,
				error: null
			}));
		});
		const unlistenLog = await tauri.listen<RuntimeLogEntry>('runtime-log', (event) => {
			appendLiveLog(event.payload);
		});
		listeners = [unlistenState, unlistenLog];
		consoleSessionActive = true;
	}

	function endConsoleSession() {
		for (const unlisten of listeners) {
			unlisten();
		}
		listeners = [];
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
			await hydrate(tauri, true);
		});
	}

	async function stop() {
		await withBusyAction('stop', async (tauri) => {
			await tauri.invoke<RuntimeStatus>('runtime_stop');
			await hydrate(tauri, true);
		});
	}

	async function restart() {
		await withBusyAction('restart', async (tauri) => {
			await tauri.invoke<RuntimeStatus>('runtime_restart');
			await hydrate(tauri, true);
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

	async function hydrate(tauri: TauriApi, includeLogTail: boolean) {
		const [status, preflight, configPath, logsPath, logTail] = await Promise.all([
			tauri.invoke<RuntimeStatus>('runtime_status'),
			tauri.invoke<RuntimePreflight>('runtime_preflight'),
			tauri.invoke<string>('runtime_get_config_path'),
			tauri.invoke<string>('runtime_get_logs_path'),
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
		clearLogs
	};
}

async function fetchLogTailForProcess(tauri: TauriApi, process: string): Promise<RuntimeLogEntry[]> {
	return tauri.invoke<RuntimeLogEntry[]>('runtime_get_logs_tail', {
		process,
		limitPerProcess: LOG_TAIL_LIMIT_PER_PROCESS
	});
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

export const desktopRuntimeStore = createDesktopRuntimeStore();
