import { browser } from '$app/environment';
import type { AdminBotKind, AdminBotPort, AdminBotRecord, AdminBotStateListener } from '../ports';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type TauriListen = <T>(
	event: string,
	handler: (event: { payload: T }) => void
) => Promise<() => void>;

let invokeFn: TauriInvoke | null = null;
let listenFn: TauriListen | null = null;

export function createTauriAdminBotPort(): AdminBotPort {
	return {
		async listBots(): Promise<AdminBotRecord[]> {
			const invoke = await requireInvoke();
			return invoke<AdminBotRecord[]>('bot_list');
		},

		async assignWallet(botKind: AdminBotKind, walletId: string | null): Promise<AdminBotRecord> {
			const invoke = await requireInvoke();
			return invoke<AdminBotRecord>('bot_assign_wallet', {
				botKind,
				walletId
			});
		},

		async startBot(botKind: AdminBotKind): Promise<AdminBotRecord> {
			const invoke = await requireInvoke();
			return invoke<AdminBotRecord>('bot_start', { botKind });
		},

		async stopBot(botKind: AdminBotKind): Promise<AdminBotRecord> {
			const invoke = await requireInvoke();
			return invoke<AdminBotRecord>('bot_stop', { botKind });
		},

		async onStateChanged(listener: AdminBotStateListener): Promise<() => void> {
			const listen = await requireListen();
			const unlistenBot = await listen<unknown>('bot-runtime-state-changed', () => {
				listener();
			});
			const unlistenRuntime = await listen<unknown>('runtime-state-changed', () => {
				listener();
			});
			return () => {
				unlistenBot();
				unlistenRuntime();
			};
		}
	};
}

async function requireInvoke(): Promise<TauriInvoke> {
	if (invokeFn) {
		return invokeFn;
	}
	if (!browser) {
		throw new Error('Bot commands are unavailable outside the desktop admin UI.');
	}
	const maybeWindow = window as Window & {
		__TAURI_INTERNALS__?: unknown;
	};
	if (!maybeWindow.__TAURI_INTERNALS__) {
		throw new Error('Bot commands are unavailable because the Tauri bridge is missing.');
	}

	const { invoke } = await import('@tauri-apps/api/core');
	invokeFn = invoke;
	return invokeFn;
}

async function requireListen(): Promise<TauriListen> {
	if (listenFn) {
		return listenFn;
	}
	if (!browser) {
		throw new Error('Bot events are unavailable outside the desktop admin UI.');
	}
	const maybeWindow = window as Window & {
		__TAURI_INTERNALS__?: unknown;
	};
	if (!maybeWindow.__TAURI_INTERNALS__) {
		throw new Error('Bot events are unavailable because the Tauri bridge is missing.');
	}

	const { listen } = await import('@tauri-apps/api/event');
	listenFn = listen;
	return listenFn;
}
