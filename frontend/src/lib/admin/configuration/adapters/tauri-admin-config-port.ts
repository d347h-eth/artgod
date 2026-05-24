import type {
	AdminConfigPort,
	AdminConfigSaveInput,
	AdminConfigState
} from '$lib/admin/configuration/ports';

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
		}
	};
}
