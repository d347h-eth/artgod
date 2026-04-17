import { browser } from '$app/environment';
import type {
	AdminWalletExportResult,
	AdminWalletImportResult,
	AdminWalletPort,
	AdminWalletRemoveResult,
	AdminWalletRecord,
	AdminWalletStatus
} from '../ports';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

let invokeFn: TauriInvoke | null = null;

export function createTauriAdminWalletPort(): AdminWalletPort {
	return {
		async getStatus(): Promise<AdminWalletStatus> {
			const invoke = await requireInvoke();
			return invoke<AdminWalletStatus>('wallet_get_status');
		},

		async listWallets(): Promise<AdminWalletRecord[]> {
			const invoke = await requireInvoke();
			return invoke<AdminWalletRecord[]>('wallet_list');
		},

		async importWallet(): Promise<AdminWalletImportResult> {
			const invoke = await requireInvoke();
			return invoke<AdminWalletImportResult>('wallet_import');
		},

		async exportWallet(walletId: string): Promise<AdminWalletExportResult> {
			const invoke = await requireInvoke();
			return invoke<AdminWalletExportResult>('wallet_export', { walletId });
		},

		async removeWallet(walletId: string): Promise<AdminWalletRemoveResult> {
			const invoke = await requireInvoke();
			return invoke<AdminWalletRemoveResult>('wallet_remove', { walletId });
		}
	};
}

async function requireInvoke(): Promise<TauriInvoke> {
	if (invokeFn) {
		return invokeFn;
	}
	if (!browser) {
		throw new Error('Wallet commands are unavailable outside the desktop admin UI.');
	}
	const maybeWindow = window as Window & {
		__TAURI_INTERNALS__?: unknown;
	};
	if (!maybeWindow.__TAURI_INTERNALS__) {
		throw new Error('Wallet commands are unavailable because the Tauri bridge is missing.');
	}

	const { invoke } = await import('@tauri-apps/api/core');
	invokeFn = invoke;
	return invokeFn;
}
