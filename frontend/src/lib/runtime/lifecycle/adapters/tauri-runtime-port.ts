import { browser } from '$app/environment';
import type {
	RuntimeLogEntry,
	RuntimeLogListener,
	RuntimePort,
	RuntimePreflight,
	RuntimeStatus,
	RuntimeStatusListener
} from '../ports';

type TauriApi = {
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
	listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
};

// Tauri IPC command names owned by the desktop runtime bridge.
const TAURI_RUNTIME_COMMANDS = {
	autoStart: 'runtime_auto_start',
	start: 'runtime_start',
	stop: 'runtime_stop',
	restart: 'runtime_restart',
	shutdown: 'runtime_shutdown',
	status: 'runtime_status',
	preflight: 'runtime_preflight',
	getConfigPath: 'runtime_get_config_path',
	getLogsPath: 'runtime_get_logs_path',
	listLogProcesses: 'runtime_list_log_processes',
	openConfigPath: 'runtime_open_config_path',
	openLogsPath: 'runtime_open_logs_path',
	openUserlandUi: 'runtime_open_userland_ui',
	getLogsTail: 'runtime_get_logs_tail'
} as const;

// Tauri event names emitted by the desktop runtime supervisor.
const TAURI_RUNTIME_EVENTS = {
	statusChanged: 'runtime-state-changed',
	log: 'runtime-log'
} as const;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createTauriRuntimePort(): RuntimePort {
	let api: TauriApi | null = null;

	async function loadBridge(maxWaitMs: number, pollIntervalMs: number): Promise<boolean> {
		if (api) {
			return true;
		}
		const deadline = Date.now() + Math.max(1, maxWaitMs);
		while (Date.now() <= deadline) {
			api = await loadTauriApi();
			if (api) {
				return true;
			}
			await sleep(Math.max(1, pollIntervalMs));
		}
		return false;
	}

	function isBridgeAvailable(): boolean {
		return api !== null;
	}

	async function autoStart(): Promise<RuntimeStatus> {
		const bridge = await requireBridge();
		return bridge.invoke<RuntimeStatus>(TAURI_RUNTIME_COMMANDS.autoStart);
	}

	async function start(): Promise<RuntimeStatus> {
		const bridge = await requireBridge();
		return bridge.invoke<RuntimeStatus>(TAURI_RUNTIME_COMMANDS.start);
	}

	async function stop(): Promise<RuntimeStatus> {
		const bridge = await requireBridge();
		return bridge.invoke<RuntimeStatus>(TAURI_RUNTIME_COMMANDS.stop);
	}

	async function restart(): Promise<RuntimeStatus> {
		const bridge = await requireBridge();
		return bridge.invoke<RuntimeStatus>(TAURI_RUNTIME_COMMANDS.restart);
	}

	async function shutdown(): Promise<void> {
		const bridge = await requireBridge();
		await bridge.invoke(TAURI_RUNTIME_COMMANDS.shutdown);
	}

	async function status(): Promise<RuntimeStatus | null> {
		const bridge = api ?? (await loadTauriApi());
		if (!bridge) {
			return null;
		}
		api = bridge;
		return bridge.invoke<RuntimeStatus>(TAURI_RUNTIME_COMMANDS.status).catch(() => null);
	}

	async function preflight(): Promise<RuntimePreflight | null> {
		const bridge = await requireBridge();
		return bridge.invoke<RuntimePreflight>(TAURI_RUNTIME_COMMANDS.preflight).catch(() => null);
	}

	async function getConfigPath(): Promise<string | null> {
		const bridge = await requireBridge();
		return bridge.invoke<string>(TAURI_RUNTIME_COMMANDS.getConfigPath).catch(() => null);
	}

	async function getLogsPath(): Promise<string | null> {
		const bridge = await requireBridge();
		return bridge.invoke<string>(TAURI_RUNTIME_COMMANDS.getLogsPath).catch(() => null);
	}

	async function listLogProcesses(): Promise<string[]> {
		const bridge = await requireBridge();
		return bridge.invoke<string[]>(TAURI_RUNTIME_COMMANDS.listLogProcesses).catch(() => []);
	}

	async function openConfigPath(): Promise<void> {
		const bridge = await requireBridge();
		await bridge.invoke(TAURI_RUNTIME_COMMANDS.openConfigPath);
	}

	async function openLogsPath(): Promise<void> {
		const bridge = await requireBridge();
		await bridge.invoke(TAURI_RUNTIME_COMMANDS.openLogsPath);
	}

	async function openUserlandUi(): Promise<void> {
		const bridge = await requireBridge();
		await bridge.invoke(TAURI_RUNTIME_COMMANDS.openUserlandUi);
	}

	async function getLogsTail(process: string, limitPerProcess: number): Promise<RuntimeLogEntry[]> {
		const bridge = await requireBridge();
		return bridge
			.invoke<RuntimeLogEntry[]>(TAURI_RUNTIME_COMMANDS.getLogsTail, {
				process,
				limitPerProcess
			})
			.catch(() => []);
	}

	async function onStatusChanged(listener: RuntimeStatusListener): Promise<() => void> {
		const bridge = await requireBridge();
		return bridge.listen<RuntimeStatus>(TAURI_RUNTIME_EVENTS.statusChanged, (event) => {
			listener(event.payload);
		});
	}

	async function onRuntimeLog(listener: RuntimeLogListener): Promise<() => void> {
		const bridge = await requireBridge();
		return bridge.listen<RuntimeLogEntry>(TAURI_RUNTIME_EVENTS.log, (event) => {
			listener(event.payload);
		});
	}

	async function requireBridge(): Promise<TauriApi> {
		if (api) {
			return api;
		}
		api = await loadTauriApi();
		if (!api) {
			throw new Error('Desktop runtime bridge is unavailable.');
		}
		return api;
	}

	return {
		loadBridge,
		isBridgeAvailable,
		autoStart,
		start,
		stop,
		restart,
		shutdown,
		status,
		preflight,
		getConfigPath,
		getLogsPath,
		listLogProcesses,
		openConfigPath,
		openLogsPath,
		openUserlandUi,
		getLogsTail,
		onStatusChanged,
		onRuntimeLog
	};
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
