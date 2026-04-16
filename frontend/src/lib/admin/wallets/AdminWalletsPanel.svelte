<script lang="ts">
	import { onMount } from 'svelte';
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import { createTauriAdminWalletPort } from '$lib/admin/wallets/adapters/tauri-admin-wallet-port';
	import type { AdminWalletRecord } from '$lib/admin/wallets/ports';

	const walletPort = createTauriAdminWalletPort();

	let wallets = $state<AdminWalletRecord[]>([]);
	let errorMessage = $state<string | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let importing = $state(false);
	let exportingWalletId = $state<string | null>(null);
	let removingWalletId = $state<string | null>(null);

	onMount(() => {
		void refreshWalletState(true);
	});

	function describeWalletState(wallet: AdminWalletRecord): string {
		if (wallet.assignedBotKinds.length === 0) {
			return 'unassigned';
		}
		return `assigned: ${wallet.assignedBotKinds.join(' / ')}`;
	}

	function describeStoredStatus(wallet: AdminWalletRecord): string {
		return wallet.status === 'stored' ? 'locked' : wallet.status;
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

	async function refreshWalletState(initialLoad = false): Promise<void> {
		if (initialLoad) {
			loading = true;
		} else {
			refreshing = true;
		}

		try {
			wallets = await walletPort.listWallets();
			errorMessage = null;
		} catch (error) {
			errorMessage = toErrorMessage(error, 'Wallet metadata could not be loaded.');
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	async function handleImport(): Promise<void> {
		if (importing || exportingWalletId !== null || removingWalletId !== null) {
			return;
		}

		importing = true;
		errorMessage = null;

		try {
			const result = await walletPort.importWallet();
			if (result.outcome === 'imported') {
				await refreshWalletState();
			}
		} catch (error) {
			errorMessage = toErrorMessage(error, 'Wallet import failed.');
		} finally {
			importing = false;
		}
	}

	async function handleExport(walletId: string): Promise<void> {
		if (importing || refreshing || exportingWalletId !== null || removingWalletId !== null) {
			return;
		}

		exportingWalletId = walletId;
		errorMessage = null;

		try {
			await walletPort.exportWallet(walletId);
		} catch (error) {
			errorMessage = toErrorMessage(error, 'Wallet export failed.');
		} finally {
			exportingWalletId = null;
		}
	}

	async function handleRemove(walletId: string): Promise<void> {
		if (importing || refreshing || exportingWalletId !== null || removingWalletId !== null) {
			return;
		}

		removingWalletId = walletId;
		errorMessage = null;

		try {
			const result = await walletPort.removeWallet(walletId);
			if (result.outcome === 'removed') {
				await refreshWalletState();
			}
		} catch (error) {
			errorMessage = toErrorMessage(error, 'Wallet removal failed.');
		} finally {
			removingWalletId = null;
		}
	}
</script>

<AdminSectionFrame>
	<div class="admin-wallet-body">
		<div class="admin-wallet-inlay">
			<section class="runtime-section">
				<div class="runtime-controls">
					<button
						type="button"
						onclick={() => void handleImport()}
						disabled={importing || refreshing || exportingWalletId !== null || removingWalletId !== null}
					>
						{importing ? 'opening native prompt…' : 'import wallet'}
					</button>

					<button
						type="button"
						onclick={() => void refreshWalletState()}
						disabled={loading || importing || refreshing || exportingWalletId !== null || removingWalletId !== null}
					>
						{refreshing ? 'refreshing…' : 'refresh'}
					</button>
				</div>

				{#if errorMessage}
					<p class="runtime-error" role="alert">{errorMessage}</p>
				{/if}

				{#if loading}
					<p class="muted">Loading wallet metadata…</p>
				{:else if wallets.length === 0}
					<p class="muted">No wallets imported yet.</p>
				{/if}
			</section>

			{#if !loading && wallets.length > 0}
				<div class="admin-wallet-list" aria-label="Configured wallets">
					{#each wallets as wallet (wallet.walletId)}
						<article class="runtime-section">
							<div class="runtime-kv-grid">
								<div>
									<span class="runtime-k">label</span>
									<span class="runtime-v">{wallet.label}</span>
								</div>
								<div>
									<span class="runtime-k">address</span>
									<span class="runtime-v mono admin-wallet-address">{wallet.address}</span>
								</div>
								<div>
									<span class="runtime-k">status</span>
									<span class="runtime-v">{describeStoredStatus(wallet)}</span>
								</div>
								<div>
									<span class="runtime-k">assignment</span>
									<span class="runtime-v">{describeWalletState(wallet)}</span>
								</div>
							</div>

							<div class="runtime-controls">
								<button
									type="button"
									onclick={() => void handleExport(wallet.walletId)}
									disabled={importing || refreshing || exportingWalletId !== null || removingWalletId !== null}
								>
									{exportingWalletId === wallet.walletId ? 'revealing…' : 'export'}
								</button>

								<button
									type="button"
									onclick={() => void handleRemove(wallet.walletId)}
									disabled={importing || refreshing || exportingWalletId !== null || removingWalletId !== null}
								>
									{removingWalletId === wallet.walletId ? 'removing…' : 'remove'}
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
	.admin-wallet-body {
		height: 100%;
		display: grid;
		align-content: start;
	}

	.admin-wallet-inlay {
		display: grid;
		gap: 0.85rem;
		width: min(48rem, 100%);
	}

	.admin-wallet-list {
		display: grid;
		gap: 0.85rem;
	}

	.admin-wallet-address {
		overflow-wrap: anywhere;
	}
</style>
