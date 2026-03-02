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
		return bridge.invoke<RuntimeStatus>('runtime_auto_start');
	}

	async function start(): Promise<RuntimeStatus> {
		const bridge = await requireBridge();
		return bridge.invoke<RuntimeStatus>('runtime_start');
	}

	async function stop(): Promise<RuntimeStatus> {
		const bridge = await requireBridge();
		return bridge.invoke<RuntimeStatus>('runtime_stop');
	}

	async function restart(): Promise<RuntimeStatus> {
		const bridge = await requireBridge();
		return bridge.invoke<RuntimeStatus>('runtime_restart');
	}

	async function status(): Promise<RuntimeStatus | null> {
		const bridge = api ?? (await loadTauriApi());
		if (!bridge) {
			return null;
		}
		api = bridge;
		return bridge.invoke<RuntimeStatus>('runtime_status').catch(() => null);
	}

	async function preflight(): Promise<RuntimePreflight | null> {
		const bridge = await requireBridge();
		return bridge.invoke<RuntimePreflight>('runtime_preflight').catch(() => null);
	}

	async function getConfigPath(): Promise<string | null> {
		const bridge = await requireBridge();
		return bridge.invoke<string>('runtime_get_config_path').catch(() => null);
	}

	async function getLogsPath(): Promise<string | null> {
		const bridge = await requireBridge();
		return bridge.invoke<string>('runtime_get_logs_path').catch(() => null);
	}

	async function openConfigPath(): Promise<void> {
		const bridge = await requireBridge();
		await bridge.invoke('runtime_open_config_path');
	}

	async function openLogsPath(): Promise<void> {
		const bridge = await requireBridge();
		await bridge.invoke('runtime_open_logs_path');
	}

	async function getLogsTail(process: string, limitPerProcess: number): Promise<RuntimeLogEntry[]> {
		const bridge = await requireBridge();
		return bridge
			.invoke<RuntimeLogEntry[]>('runtime_get_logs_tail', {
				process,
				limitPerProcess
			})
			.catch(() => []);
	}

	async function onStatusChanged(listener: RuntimeStatusListener): Promise<() => void> {
		const bridge = await requireBridge();
		return bridge.listen<RuntimeStatus>('runtime-state-changed', (event) => {
			listener(event.payload);
		});
	}

	async function onRuntimeLog(listener: RuntimeLogListener): Promise<() => void> {
		const bridge = await requireBridge();
		return bridge.listen<RuntimeLogEntry>('runtime-log', (event) => {
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
		status,
		preflight,
		getConfigPath,
		getLogsPath,
		openConfigPath,
		openLogsPath,
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
