<script lang="ts">
	import { onMount } from 'svelte';
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import { createTauriAdminBotPort } from '$lib/admin/bots/adapters/tauri-admin-bot-port';
	import type { AdminBotKind, AdminBotRecord } from '$lib/admin/bots/ports';
	import { createTauriAdminWalletPort } from '$lib/admin/wallets/adapters/tauri-admin-wallet-port';
	import type { AdminWalletRecord } from '$lib/admin/wallets/ports';

	const botPort = createTauriAdminBotPort();
	const walletPort = createTauriAdminWalletPort();
	const BOT_ORDER: AdminBotKind[] = ['bidding', 'sniping'];

	let bots = $state<AdminBotRecord[]>([]);
	let wallets = $state<AdminWalletRecord[]>([]);
	let selectedWalletIds = $state<Record<AdminBotKind, string>>({
		bidding: '',
		sniping: ''
	});
	let errorMessage = $state<string | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let busyAction = $state<string | null>(null);

	onMount(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;

		void refreshState(true);
		void botPort.onStateChanged(() => {
			if (!disposed) {
				void refreshState();
			}
		}).then((callback) => {
			if (disposed) {
				callback();
				return;
			}
			unlisten = callback;
		});

		return () => {
			disposed = true;
			unlisten?.();
		};
	});

	function orderedBots(records: AdminBotRecord[]): AdminBotRecord[] {
		return [...records].sort(
			(left, right) => BOT_ORDER.indexOf(left.botKind) - BOT_ORDER.indexOf(right.botKind)
		);
	}

	function syncSelections(nextBots: AdminBotRecord[]): void {
		selectedWalletIds = {
			bidding: nextBots.find((bot) => bot.botKind === 'bidding')?.assignedWallet?.walletId ?? '',
			sniping: nextBots.find((bot) => bot.botKind === 'sniping')?.assignedWallet?.walletId ?? ''
		};
	}

	function toErrorMessage(error: unknown, fallback: string): string {
		if (error instanceof Error && error.message.trim().length > 0) {
			return error.message;
		}
		if (typeof error === 'string' && error.trim().length > 0) {
			return error;
		}
		return fallback;
	}

	function formatBotLabel(botKind: AdminBotKind): string {
		return botKind === 'bidding' ? 'bidding bot' : 'sniping bot';
	}

	function describeAssignedWallet(bot: AdminBotRecord): string {
		if (!bot.assignedWallet) {
			return 'unassigned';
		}
		return `${bot.assignedWallet.label} · ${bot.assignedWallet.address}`;
	}

	function describeDependencies(bot: AdminBotRecord): string {
		const unhealthy = bot.criticalDependencies.filter((dependency) => !dependency.healthy);
		if (unhealthy.length === 0) {
			return 'healthy';
		}
		return `missing: ${unhealthy.map((dependency) => dependency.process).join(', ')}`;
	}

	function canStart(bot: AdminBotRecord): boolean {
		return (
			bot.disabledReason === null &&
			bot.assignedWallet !== null &&
			bot.state !== 'awaiting_unlock' &&
			bot.state !== 'starting' &&
			bot.state !== 'bootstrapping' &&
			bot.state !== 'running'
		);
	}

	function updateSelectedWallet(botKind: AdminBotKind, value: string): void {
		selectedWalletIds = {
			...selectedWalletIds,
			[botKind]: value
		};
	}

	async function refreshState(initialLoad = false): Promise<void> {
		if (initialLoad) {
			loading = true;
		} else {
			refreshing = true;
		}

		try {
			const [nextBots, nextWallets] = await Promise.all([botPort.listBots(), walletPort.listWallets()]);
			bots = orderedBots(nextBots);
			wallets = nextWallets;
			syncSelections(bots);
			errorMessage = null;
		} catch (error) {
			errorMessage = toErrorMessage(error, 'Bot state could not be loaded.');
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	async function withBusyAction(actionKey: string, work: () => Promise<void>): Promise<void> {
		if (busyAction !== null) {
			return;
		}
		busyAction = actionKey;
		errorMessage = null;
		try {
			await work();
		} catch (error) {
			errorMessage = toErrorMessage(error, 'Bot action failed.');
		} finally {
			busyAction = null;
		}
	}

	async function handleAssignWallet(botKind: AdminBotKind): Promise<void> {
		await withBusyAction(`assign:${botKind}`, async () => {
			await botPort.assignWallet(botKind, selectedWalletIds[botKind] || null);
			await refreshState();
		});
	}

	async function handleStart(botKind: AdminBotKind): Promise<void> {
		await withBusyAction(`start:${botKind}`, async () => {
			await botPort.startBot(botKind);
			await refreshState();
		});
	}

	async function handleStop(botKind: AdminBotKind): Promise<void> {
		await withBusyAction(`stop:${botKind}`, async () => {
			await botPort.stopBot(botKind);
			await refreshState();
		});
	}
</script>

<AdminSectionFrame>
	<div class="admin-bots-body">
		<div class="admin-bots-inlay">
			<section class="runtime-section">
				<div class="runtime-controls">
					<button
						type="button"
						onclick={() => void refreshState()}
						disabled={loading || refreshing || busyAction !== null}
					>
						{refreshing ? 'refreshing…' : 'refresh'}
					</button>
				</div>

				{#if errorMessage}
					<p class="runtime-error" role="alert">{errorMessage}</p>
				{/if}

				{#if loading}
					<p class="muted">Loading bot runtime state…</p>
				{/if}
			</section>

			{#if !loading}
				<div class="admin-bots-list" aria-label="Configured bot runtimes">
					{#each bots as bot (bot.botKind)}
						<article class="runtime-section">
							<div class="runtime-kv-grid">
								<div>
									<span class="runtime-k">bot</span>
									<span class="runtime-v">{formatBotLabel(bot.botKind)}</span>
								</div>
								<div>
									<span class="runtime-k">state</span>
									<span class="runtime-v">{bot.state}</span>
								</div>
								<div>
									<span class="runtime-k">wallet</span>
									<span class="runtime-v admin-bot-wallet">{describeAssignedWallet(bot)}</span>
								</div>
								<div>
									<span class="runtime-k">process</span>
									<span class="runtime-v mono">{bot.processName}</span>
								</div>
								<div>
									<span class="runtime-k">critical deps</span>
									<span class="runtime-v">{describeDependencies(bot)}</span>
								</div>
							</div>

							{#if bot.lastError && bot.lastError !== bot.disabledReason}
								<p class="runtime-error" role="alert">{bot.lastError}</p>
							{/if}
							{#if bot.disabledReason}
								<p class="runtime-error" role="alert">{bot.disabledReason}</p>
							{/if}

							<div class="runtime-controls admin-bot-controls">
								<select
									value={selectedWalletIds[bot.botKind]}
									onchange={(event) => {
										updateSelectedWallet(
											bot.botKind,
											(event.currentTarget as HTMLSelectElement).value
										);
									}}
									disabled={busyAction !== null || bot.state === 'running' || bot.state === 'bootstrapping' || bot.state === 'starting' || bot.state === 'awaiting_unlock'}
								>
									<option value="">unassigned</option>
									{#each wallets as wallet (wallet.walletId)}
										<option value={wallet.walletId}>
											{wallet.label} · {wallet.address}
										</option>
									{/each}
								</select>

								<button
									type="button"
									onclick={() => void handleAssignWallet(bot.botKind)}
									disabled={busyAction !== null || bot.state === 'running' || bot.state === 'bootstrapping' || bot.state === 'starting' || bot.state === 'awaiting_unlock'}
								>
									{busyAction === `assign:${bot.botKind}` ? 'applying…' : 'apply wallet'}
								</button>

								<button
									type="button"
									onclick={() => void handleStart(bot.botKind)}
									disabled={busyAction !== null || !canStart(bot)}
								>
									{busyAction === `start:${bot.botKind}` ? 'starting…' : 'start'}
								</button>

								<button
									type="button"
									onclick={() => void handleStop(bot.botKind)}
									disabled={busyAction !== null || (bot.state !== 'running' && bot.state !== 'bootstrapping')}
								>
									{busyAction === `stop:${bot.botKind}` ? 'stopping…' : 'stop'}
								</button>
							</div>
						</article>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</AdminSectionFrame>

<style>
	.admin-bots-body {
		height: 100%;
		display: grid;
		align-content: start;
	}

	.admin-bots-inlay {
		display: grid;
		gap: 0.85rem;
		width: min(48rem, 100%);
	}

	.admin-bots-list {
		display: grid;
		gap: 0.85rem;
	}

	.admin-bot-controls {
		flex-wrap: wrap;
	}

	.admin-bot-controls select {
		min-width: min(24rem, 100%);
		max-width: 100%;
	}

	.admin-bot-wallet {
		overflow-wrap: anywhere;
	}
</style>
