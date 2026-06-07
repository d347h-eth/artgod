import type {
	AdminConfigPort,
	AdminRpcEndpointBenchmarkInput,
	AdminRpcEndpointBenchmarkResult,
	AdminConfigSaveInput,
	AdminConfigState
} from '$lib/admin/configuration/ports';

// Tauri command that runs Admin-side HTTP RPC sourcing and benchmarking before runtime startup.
const APP_CONFIG_BENCHMARK_RPC_ENDPOINTS_COMMAND = 'app_config_benchmark_rpc_endpoints';

type TauriApi = {
	invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

export function createTauriAdminConfigPort(): AdminConfigPort {
	async function requireBridge(): Promise<TauriApi> {
		const maybeWindow = window as Window & {
			__TAURI_INTERNALS__?: unknown;
		};
		if (!maybeWindow.__TAURI_INTERNALS__) {
			throw new Error('Desktop runtime bridge is unavailable.');
		}
		const { invoke } = await import('@tauri-apps/api/core');
		return { invoke };
	}

	return {
		async getConfig(): Promise<AdminConfigState> {
			const bridge = await requireBridge();
			return bridge.invoke<AdminConfigState>('app_config_get');
		},
		async saveConfig(input: AdminConfigSaveInput): Promise<AdminConfigState> {
			const bridge = await requireBridge();
			return bridge.invoke<AdminConfigState>('app_config_save', { input });
		},
		async useDefaults(): Promise<AdminConfigState> {
			const bridge = await requireBridge();
			return bridge.invoke<AdminConfigState>('app_config_use_defaults');
		},
		async benchmarkRpcEndpoints(
			input: AdminRpcEndpointBenchmarkInput
		): Promise<AdminRpcEndpointBenchmarkResult> {
			const bridge = await requireBridge();
			return bridge.invoke<AdminRpcEndpointBenchmarkResult>(
				APP_CONFIG_BENCHMARK_RPC_ENDPOINTS_COMMAND,
				{ input }
			);
		}
	};
}
