<script lang="ts">
	import { onMount } from 'svelte';
	import { TRADING_BOT_KIND } from '@artgod/shared/types';
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import { createTauriAdminBotPort } from '$lib/admin/bots/adapters/tauri-admin-bot-port';
	import type {
		AdminBiddingCollectionCandidate,
		AdminBotKind,
		AdminBotRecord
	} from '$lib/admin/bots/ports';
	import { ADMIN_BOT_STATE, isAdminBotActive } from '$lib/admin/bots/ports';
	import {
		buildBiddingMandateDraft,
		formatBiddingMandateWeiAsEth,
		isBiddingMandateDraftReady,
		syncBiddingMandateSelections,
		type BiddingCollectionMandateSelection,
		type BiddingMandateSelections
	} from '$lib/admin/bots/bidding-mandate-draft';
	import {
		buildBiddingStartPolicySummary,
		type BiddingStartPolicyEntry
	} from '$lib/admin/bots/bidding-start-policy';
	import type { AdminConfigState } from '$lib/admin/configuration/ports';
	import { createTauriAdminWalletPort } from '$lib/admin/wallets/adapters/tauri-admin-wallet-port';
	import type { AdminWalletRecord } from '$lib/admin/wallets/ports';

	const botPort = createTauriAdminBotPort();
	const walletPort = createTauriAdminWalletPort();
	const BOT_ORDER: AdminBotKind[] = [TRADING_BOT_KIND.Bidding, TRADING_BOT_KIND.Sniping];
	let {
		config,
		configLoading = false
	}: { config: AdminConfigState | null; configLoading?: boolean } = $props();

	let bots = $state<AdminBotRecord[]>([]);
	let wallets = $state<AdminWalletRecord[]>([]);
	let biddingCollections = $state<AdminBiddingCollectionCandidate[]>([]);
	let biddingMandateSelections = $state<BiddingMandateSelections>({});
	let biddingMandateReady = $derived(
		isBiddingMandateDraftReady(biddingCollections, biddingMandateSelections)
	);
	let biddingStartPolicy: BiddingStartPolicyEntry[] = $derived(
		config ? buildBiddingStartPolicySummary(config.values) : []
	);
	let selectedWalletIds = $state<Record<AdminBotKind, string>>({
		[TRADING_BOT_KIND.Bidding]: '',
		[TRADING_BOT_KIND.Sniping]: ''
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
			[TRADING_BOT_KIND.Bidding]:
				nextBots.find((bot) => bot.botKind === TRADING_BOT_KIND.Bidding)?.assignedWallet
					?.walletId ?? '',
			[TRADING_BOT_KIND.Sniping]:
				nextBots.find((bot) => bot.botKind === TRADING_BOT_KIND.Sniping)?.assignedWallet
					?.walletId ?? ''
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
		return botKind === TRADING_BOT_KIND.Bidding ? 'bidding bot' : 'sniping bot';
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
			!isAdminBotActive(bot.state) &&
			(bot.botKind !== TRADING_BOT_KIND.Bidding || biddingMandateReady)
		);
	}

	function describeTokenScope(candidate: AdminBiddingCollectionCandidate): string {
		const details = candidate.tokenScope.items.map((item) => `${item.label}: ${item.value}`);
		return [candidate.tokenScope.label, ...details].join(' · ');
	}

	function updateSelectedWallet(botKind: AdminBotKind, value: string): void {
		selectedWalletIds = {
			...selectedWalletIds,
			[botKind]: value
		};
	}

	function updateBiddingMandateSelection(
		collectionId: number,
		update: Partial<BiddingCollectionMandateSelection>
	): void {
		const key = String(collectionId);
		const current = biddingMandateSelections[key];
		if (!current) return;
		biddingMandateSelections = {
			...biddingMandateSelections,
			[key]: { ...current, ...update }
		};
	}

	async function refreshState(initialLoad = false): Promise<void> {
		if (initialLoad) {
			loading = true;
		} else {
			refreshing = true;
		}

		try {
			const [nextBots, nextWallets, nextBiddingCollections] = await Promise.all([
				botPort.listBots(),
				walletPort.listWallets(),
				botPort.listBiddingCollections()
			]);
			bots = orderedBots(nextBots);
			wallets = nextWallets;
			biddingCollections = nextBiddingCollections;
			biddingMandateSelections = syncBiddingMandateSelections(
				nextBiddingCollections,
				biddingMandateSelections
			);
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
			const biddingMandate =
				botKind === TRADING_BOT_KIND.Bidding
					? buildBiddingMandateDraft(biddingCollections, biddingMandateSelections)
					: null;
			await botPort.startBot(botKind, biddingMandate);
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

				{#if loading || configLoading}
					<p class="muted">Loading bot runtime state…</p>
				{/if}
				{#if !configLoading && config === null}
					<p class="runtime-error" role="alert">Effective bot policy could not be loaded.</p>
				{/if}
			</section>

			{#if !loading && !configLoading && config !== null}
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
							{#if bot.botKind === TRADING_BOT_KIND.Bidding}
								<div class="bidding-start-policy" aria-label="Effective bidding bot start policy">
									<span class="runtime-k">start policy</span>
									<dl>
										{#each biddingStartPolicy as entry (entry.label)}
											<div>
												<dt>{entry.label}</dt>
												<dd>{entry.value}</dd>
											</div>
										{/each}
									</dl>
								</div>

								<fieldset class="bidding-mandate-editor" disabled={busyAction !== null || isAdminBotActive(bot.state)}>
									<legend>native collection mandate</legend>
									{#if biddingCollections.length === 0}
										<span class="muted">no live OpenSea-ready collections</span>
									{:else}
										<div class="bidding-mandate-collections">
											{#each biddingCollections as collection (collection.collectionId)}
												{@const selection = biddingMandateSelections[String(collection.collectionId)]}
												{#if selection}
													<div class="bidding-mandate-row">
														<label class="bidding-mandate-choice">
															<input
																type="checkbox"
																checked={selection.selected}
																onchange={(event) =>
																	updateBiddingMandateSelection(collection.collectionId, {
																		selected: event.currentTarget.checked
																	})}
															/>
															<strong>{collection.artgodSlug}</strong>
															<span class="mono">#{collection.collectionId}</span>
														</label>
														<div class="bidding-mandate-identity mono">
															<span>OpenSea: {collection.openseaSlug}</span>
															<span>{collection.contractAddress}</span>
															<span>{describeTokenScope(collection)}</span>
														</div>
														<div class="bidding-mandate-caps">
															<label>
																max WETH / NFT
																<input
																	type="text"
																	inputmode="decimal"
																	value={selection.maxUnitBidEth}
																	disabled={!selection.selected}
																	oninput={(event) =>
																		updateBiddingMandateSelection(collection.collectionId, {
																			maxUnitBidEth: event.currentTarget.value
																		})}
																/>
															</label>
															<label>
																max quantity
																<input
																	type="number"
																	min="1"
																	step="1"
																	value={selection.maxQuantity}
																	disabled={!selection.selected}
																	oninput={(event) =>
																		updateBiddingMandateSelection(collection.collectionId, {
																			maxQuantity: event.currentTarget.value
																		})}
																/>
															</label>
														</div>
													</div>
												{/if}
											{/each}
										</div>
									{/if}
								</fieldset>

								{#if bot.biddingMandate}
									<div class="active-bidding-mandate" aria-label="Active native bidding mandate">
										<span class="runtime-k">active mandate · chain {bot.biddingMandate.chainId}</span>
										{#each bot.biddingMandate.collections as collection (collection.collectionId)}
											<div>
												<strong>{collection.artgodSlug}</strong>
												<span class="mono">#{collection.collectionId} · {collection.openseaSlug}</span>
												<span>{formatBiddingMandateWeiAsEth(collection.maxUnitBidWei)} / NFT · qty ≤ {collection.maxQuantity}</span>
											</div>
										{/each}
									</div>
								{/if}
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
									disabled={busyAction !== null || isAdminBotActive(bot.state)}
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
									disabled={busyAction !== null || isAdminBotActive(bot.state)}
								>
									{busyAction === `assign:${bot.botKind}` ? 'applying…' : 'apply wallet'}
								</button>

								{#if bot.botKind === TRADING_BOT_KIND.Bidding}
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
										disabled={busyAction !== null || (bot.state !== ADMIN_BOT_STATE.Running && bot.state !== ADMIN_BOT_STATE.Bootstrapping)}
									>
										{busyAction === `stop:${bot.botKind}` ? 'stopping…' : 'stop'}
									</button>
								{:else}
									<span class="muted">unavailable</span>
								{/if}
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

	.bidding-start-policy {
		display: grid;
		gap: 0.35rem;
		width: fit-content;
		max-width: 100%;
	}

	.bidding-start-policy dl {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, max-content));
		gap: 0.3rem 1.25rem;
		margin: 0;
	}

	.bidding-start-policy dl > div {
		display: contents;
	}

	.bidding-start-policy dt,
	.bidding-start-policy dd {
		margin: 0;
	}

	.bidding-start-policy dt {
		color: var(--c-sand);
	}

	.bidding-start-policy dd {
		overflow-wrap: anywhere;
	}

	.bidding-mandate-editor {
		display: grid;
		gap: 0.5rem;
		width: fit-content;
		max-width: 100%;
		margin: 0;
		border: 1px solid var(--c-sand);
	}

	.bidding-mandate-collections,
	.active-bidding-mandate {
		display: grid;
		gap: 0.65rem;
	}

	.bidding-mandate-row {
		display: grid;
		gap: 0.35rem;
		padding-bottom: 0.65rem;
		border-bottom: 1px solid var(--c-sand);
	}

	.bidding-mandate-row:last-child {
		padding-bottom: 0;
		border-bottom: 0;
	}

	.bidding-mandate-choice,
	.bidding-mandate-caps,
	.bidding-mandate-caps label {
		display: flex;
		align-items: center;
		gap: 0.45rem;
	}

	.bidding-mandate-identity {
		display: grid;
		gap: 0.15rem;
		max-width: 42rem;
		overflow-wrap: anywhere;
	}

	.bidding-mandate-caps {
		flex-wrap: wrap;
	}

	.bidding-mandate-caps input {
		width: 8rem;
	}

	.active-bidding-mandate {
		width: fit-content;
		max-width: 100%;
	}

	.active-bidding-mandate > div {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}
</style>
