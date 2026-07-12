<script lang="ts">
	import { onMount } from 'svelte';
	import { TRADING_BOT_KIND } from '@artgod/shared/types';
	import AdminSectionFrame from '$lib/admin/components/AdminSectionFrame.svelte';
	import { createTauriAdminBotPort } from '$lib/admin/bots/adapters/tauri-admin-bot-port';
	import { BIDDING_AUTHORIZATION_CAP_COPY } from '$lib/admin/bots/bidding-authorization-copy';
	import InfoTooltip from '$lib/components/InfoTooltip.svelte';
	import type {
		AdminBiddingCollectionCatalog,
		AdminBiddingCollectionCandidate,
		AdminBotKind,
		AdminBotRecord
	} from '$lib/admin/bots/ports';
	import { ADMIN_BOT_STATE, isAdminBotActive } from '$lib/admin/bots/ports';
	import {
		buildBiddingMandateDraft,
		formatBiddingChainIdentity,
		formatBiddingMandateTokenScope,
		formatBiddingMandateWeiAsEth,
		isBiddingMandateDraftReady,
		sortBiddingCollectionCandidatesByMaxUnitBid,
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
	let {
		config,
		configLoading = false
	}: { config: AdminConfigState | null; configLoading?: boolean } = $props();

	let bots = $state<AdminBotRecord[]>([]);
	let wallets = $state<AdminWalletRecord[]>([]);
	let biddingCollectionCatalog = $state<AdminBiddingCollectionCatalog | null>(null);
	let biddingCollections: AdminBiddingCollectionCandidate[] = $derived(
		sortBiddingCollectionCandidatesByMaxUnitBid(biddingCollectionCatalog?.collections ?? [])
	);
	let biddingMandateSelections = $state<BiddingMandateSelections>({});
	let biddingMandateReady = $derived(
		isBiddingMandateDraftReady(biddingCollections, biddingMandateSelections)
	);
	let biddingStartPolicy: BiddingStartPolicyEntry[] = $derived(
		config ? buildBiddingStartPolicySummary(config) : []
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

	function visibleBots(records: AdminBotRecord[]): AdminBotRecord[] {
		return records.filter((bot) => bot.botKind === TRADING_BOT_KIND.Bidding);
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
			biddingMandateReady
		);
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
			const [nextBots, nextWallets, nextBiddingCollectionCatalog] = await Promise.all([
				botPort.listBots(),
				walletPort.listWallets(),
				botPort.loadBiddingCollectionCatalog()
			]);
			bots = visibleBots(nextBots);
			wallets = nextWallets;
			biddingCollectionCatalog = nextBiddingCollectionCatalog;
			biddingMandateSelections = syncBiddingMandateSelections(
				nextBiddingCollectionCatalog.collections,
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
						{@const botActive = isAdminBotActive(bot.state)}
						<article class="admin-bot-runtime">
							<section class="runtime-section" aria-label="Bot state">
								<h3>bot state</h3>
								<div class="runtime-kv-grid">
									<div>
										<span class="runtime-k">bot</span>
										<span class="runtime-v">bidding bot</span>
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
							</section>

							{#if bot.botKind === TRADING_BOT_KIND.Bidding}
								{@const mandateEditingDisabled = busyAction !== null || botActive}
								<section
									class="runtime-section bidding-start-policy"
									aria-label="Bidding settings"
								>
									<h3>bidding settings</h3>
									<dl class="admin-setting-list">
										{#each biddingStartPolicy as entry (entry.key)}
											<div class="admin-setting-row">
												<dt class="admin-setting-label-cell">
													<span>{entry.label}</span>
													<InfoTooltip
														text={entry.help}
														className="admin-setting-label-tooltip"
													/>
												</dt>
												<dd class="admin-setting-value">{entry.value}</dd>
											</div>
										{/each}
									</dl>
								</section>

								<section
									class="runtime-section bidding-mandate-editor"
									aria-label="Bidding authorization request"
								>
									<h3>
										bidding authorization request
										{#if biddingCollectionCatalog}
											· {formatBiddingChainIdentity(biddingCollectionCatalog.chain)}
										{/if}
									</h3>
									{#if biddingCollections.length === 0}
										<span class="muted">no live OpenSea-ready collections</span>
									{:else}
										<div class="bidding-mandate-collections">
											{#each biddingCollections as collection (collection.collectionId)}
												{@const selection = biddingMandateSelections[String(collection.collectionId)]}
												{#if selection}
													<div class="bootstrap-form-section bidding-mandate-row">
														<label class="bidding-mandate-choice">
															<input
																type="checkbox"
																class="bootstrap-checkbox"
																checked={selection.selected}
																disabled={mandateEditingDisabled}
																onchange={(event) =>
																	updateBiddingMandateSelection(collection.collectionId, {
																		selected: event.currentTarget.checked
																	})}
															/>
															<span class="runtime-v">
																<strong>{collection.artgodSlug}</strong>
																<span class="mono">· ArtGod collection ID #{collection.collectionId}</span>
															</span>
														</label>
														<div class="runtime-kv-grid bidding-mandate-identity">
															<div>
																<span class="runtime-k">OpenSea slug</span>
																<span class="runtime-v mono">{collection.openseaSlug}</span>
															</div>
															<div>
																<span class="runtime-k">contract address</span>
																<span class="runtime-v mono">{collection.contractAddress}</span>
															</div>
															<div>
																<span class="runtime-k">token scope</span>
																<span class="runtime-v">{formatBiddingMandateTokenScope(collection.tokenScope)}</span>
															</div>
														</div>
														<div class="bootstrap-form bidding-mandate-caps">
															<label class="bootstrap-form-row">
																<span class="bootstrap-form-label-cell">
																	<span>{BIDDING_AUTHORIZATION_CAP_COPY.maxUnitBid.label}</span>
																	<InfoTooltip
																		text={BIDDING_AUTHORIZATION_CAP_COPY.maxUnitBid.help}
																		className="bootstrap-form-label-tooltip"
																	/>
																</span>
																<input
																	type="text"
																	class="bootstrap-control mono bid-book-price"
																	inputmode="decimal"
																	value={selection.maxUnitBidEth}
																	disabled={mandateEditingDisabled || !selection.selected}
																	oninput={(event) =>
																		updateBiddingMandateSelection(collection.collectionId, {
																			maxUnitBidEth: event.currentTarget.value,
																			maxUnitBidEthEdited: true
																		})}
																/>
															</label>
															<label class="bootstrap-form-row">
																<span class="bootstrap-form-label-cell">
																	<span>{BIDDING_AUTHORIZATION_CAP_COPY.maxQuantity.label}</span>
																	<InfoTooltip
																		text={BIDDING_AUTHORIZATION_CAP_COPY.maxQuantity.help}
																		className="bootstrap-form-label-tooltip"
																	/>
																</span>
																<input
																	type="text"
																	class="bootstrap-control"
																	inputmode="numeric"
																	value={biddingCollectionCatalog?.maxOfferQuantity ?? ''}
																	readonly
																	aria-readonly="true"
																/>
															</label>
														</div>
													</div>
												{/if}
											{/each}
										</div>
									{/if}
								</section>

								{#if bot.biddingMandate}
									<section
										class="runtime-section active-bidding-mandate"
										aria-label="Active bidding authorization"
									>
										<h3>
											active bidding authorization
											{#if biddingCollectionCatalog}
												· {formatBiddingChainIdentity(
													biddingCollectionCatalog.chain,
													bot.biddingMandate.chainId
												)}
											{:else}
												· chain ID #{bot.biddingMandate.chainId}
											{/if}
										</h3>
										{#each bot.biddingMandate.collections as collection (collection.collectionId)}
											<div class="bootstrap-form-section">
												<span class="runtime-v">
													<strong>{collection.artgodSlug}</strong>
													<span class="mono">· ArtGod collection ID #{collection.collectionId}</span>
												</span>
												<div class="runtime-kv-grid bidding-mandate-identity">
													<div>
														<span class="runtime-k">OpenSea slug</span>
														<span class="runtime-v mono">{collection.openseaSlug}</span>
													</div>
													<div>
														<span class="runtime-k">contract address</span>
														<span class="runtime-v mono">{collection.contractAddress}</span>
													</div>
													<div>
														<span class="runtime-k">token scope</span>
														<span class="runtime-v">{formatBiddingMandateTokenScope(collection.tokenScope)}</span>
													</div>
													<div>
														<span class="runtime-k bidding-mandate-cap-summary-label">
															<span>{BIDDING_AUTHORIZATION_CAP_COPY.maxUnitBid.label}</span>
															<InfoTooltip text={BIDDING_AUTHORIZATION_CAP_COPY.maxUnitBid.help} />
														</span>
														<span class="runtime-v mono bid-book-price"
															>{formatBiddingMandateWeiAsEth(collection.maxUnitBidWei)}</span
														>
													</div>
													<div>
														<span class="runtime-k bidding-mandate-cap-summary-label">
															<span>{BIDDING_AUTHORIZATION_CAP_COPY.maxQuantity.label}</span>
															<InfoTooltip text={BIDDING_AUTHORIZATION_CAP_COPY.maxQuantity.help} />
														</span>
														<span class="runtime-v">{collection.maxQuantity}</span>
													</div>
												</div>
											</div>
										{/each}
									</section>
								{/if}
							{/if}

							<div class="admin-bot-controls">
								<div class="runtime-controls">
									<select
										class="bootstrap-control-select"
										value={selectedWalletIds[bot.botKind]}
										onchange={(event) => {
											updateSelectedWallet(
												bot.botKind,
												(event.currentTarget as HTMLSelectElement).value
											);
										}}
										disabled={busyAction !== null || botActive}
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
										class="action-button-positive"
										onclick={() => void handleAssignWallet(bot.botKind)}
										disabled={busyAction !== null || botActive}
									>
										{busyAction === `assign:${bot.botKind}` ? 'applying…' : 'apply wallet'}
									</button>
								</div>

								<div class="runtime-controls">
									<button
										type="button"
										class="action-button-negative"
										onclick={() => void handleStop(bot.botKind)}
										disabled={busyAction !== null || (bot.state !== ADMIN_BOT_STATE.Running && bot.state !== ADMIN_BOT_STATE.Bootstrapping)}
									>
										{busyAction === `stop:${bot.botKind}` ? 'stopping…' : 'stop'}
									</button>

									<button
										type="button"
										class="action-button-positive"
										onclick={() => void handleStart(bot.botKind)}
										disabled={busyAction !== null || !canStart(bot)}
									>
										{busyAction === `start:${bot.botKind}` ? 'starting…' : 'start'}
									</button>
								</div>
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

	.admin-bot-runtime {
		display: grid;
		gap: 1.35rem;
		min-width: 0;
	}

	.admin-bot-controls {
		display: grid;
		gap: 0.45rem;
		width: min(40.15rem, 100%);
		max-width: 100%;
	}

	.admin-bot-controls select {
		width: min(24rem, 100%);
		min-width: 0;
		max-width: 100%;
	}

	.admin-bot-controls button {
		min-width: 7.25rem;
	}

	.admin-bot-wallet {
		overflow-wrap: anywhere;
	}

	.bidding-start-policy {
		display: grid;
		align-content: start;
		gap: 0.72rem;
		width: min(40.15rem, 100%);
		max-width: 100%;
	}

	.bidding-start-policy dl {
		display: grid;
		gap: 0.72rem;
		margin: 0;
	}

	.bidding-start-policy dt,
	.bidding-start-policy dd {
		margin: 0;
	}

	.bidding-mandate-editor {
		display: grid;
		gap: 0.55rem;
		width: min(40.15rem, 100%);
		max-width: 100%;
		margin: 0;
	}

	.bidding-mandate-collections,
	.active-bidding-mandate {
		display: grid;
		gap: 0.55rem;
	}

	.bidding-mandate-row {
		gap: 0.65rem;
	}

	.bidding-mandate-choice {
		display: inline-flex;
		align-items: center;
		gap: 0.45rem;
		width: fit-content;
		max-width: 100%;
	}

	.bidding-mandate-choice .runtime-v {
		display: inline-flex;
		align-items: baseline;
		gap: 0.35rem;
		min-width: 0;
	}

	.bidding-mandate-choice .bootstrap-checkbox:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.bidding-mandate-identity {
		display: grid;
		gap: 0.25rem;
		width: 100%;
		max-width: 100%;
		overflow-wrap: anywhere;
	}

	.bidding-mandate-identity > div {
		display: grid;
		grid-template-columns: 8.75rem minmax(0, 1fr);
		align-items: baseline;
		gap: 0.7rem;
	}

	.bidding-mandate-identity .runtime-v {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.bidding-mandate-caps {
		display: grid;
		gap: 0.35rem;
		width: fit-content;
		max-width: 100%;
		padding: 0;
	}

	.bidding-mandate-caps .bootstrap-form-row {
		grid-template-columns: 13.75rem 11ch;
		gap: 0.7rem;
		width: fit-content;
	}

	.bidding-mandate-caps .bootstrap-form-row > span {
		justify-self: end;
		text-align: right;
	}

	.bidding-mandate-cap-summary-label {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		min-width: 0;
	}

	.bidding-mandate-caps input {
		width: 100%;
		justify-self: stretch;
	}

	.bidding-mandate-caps .bootstrap-control.bid-book-price:disabled {
		color: var(--c-yellow);
	}

	.active-bidding-mandate {
		width: min(40.15rem, 100%);
		max-width: 100%;
	}

	.active-bidding-mandate > .bootstrap-form-section {
		gap: 0.65rem;
	}

	.active-bidding-mandate .bidding-mandate-identity > div {
		grid-template-columns: 13.75rem minmax(0, 1fr);
	}
</style>
