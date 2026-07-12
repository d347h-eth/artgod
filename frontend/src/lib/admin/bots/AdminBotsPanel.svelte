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
		AdminBotPort,
		AdminBotRecord
	} from '$lib/admin/bots/ports';
	import { formatAdminBotState, isAdminBotActive } from '$lib/admin/bots/ports';
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
		buildActiveBiddingPolicySummary,
		buildBiddingSettingsSummary,
		type BiddingSettingEntry
	} from '$lib/admin/bots/bidding-start-policy';
	import {
		beginAdminBotStart,
		beginAdminBotStop,
		canStopAdminBot,
		createAdminBotActionState,
		finishAdminBotAction,
		isAdminBotLifecycleActionPending,
		isAdminBotStartPending,
		isAdminBotStopPending,
		isCurrentAdminBotAction
	} from '$lib/admin/bots/admin-bot-action-state';
	import {
		beginAdminBotRefresh,
		beginAdminBotViewAction,
		createAdminBotViewState,
		finishAdminBotRefreshFailure,
		finishAdminBotRefreshSuccess,
		isCurrentAdminBotRefresh,
		publishAdminBotActionError
	} from '$lib/admin/bots/admin-bot-view-state';
	import type { AdminConfigState } from '$lib/admin/configuration/ports';
	import { createTauriAdminWalletPort } from '$lib/admin/wallets/adapters/tauri-admin-wallet-port';
	import type { AdminWalletPort, AdminWalletRecord } from '$lib/admin/wallets/ports';

	let {
		config,
		configLoading = false,
		botPort = createTauriAdminBotPort(),
		walletPort = createTauriAdminWalletPort()
	}: {
		config: AdminConfigState | null;
		configLoading?: boolean;
		botPort?: AdminBotPort;
		walletPort?: AdminWalletPort;
	} = $props();

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
	let biddingSettingsProjection = $derived.by((): {
		entries: BiddingSettingEntry[];
		error: string | null;
	} => {
		if (!config) return { entries: [], error: null };
		try {
			return { entries: buildBiddingSettingsSummary(config), error: null };
		} catch {
			return {
				entries: [],
				error: 'Bidding settings are invalid. Review Config, save the correction, then refresh Bots.'
			};
		}
	});
	let selectedWalletIds = $state<Record<AdminBotKind, string>>({
		[TRADING_BOT_KIND.Bidding]: '',
		[TRADING_BOT_KIND.Sniping]: ''
	});
	let viewState = $state(createAdminBotViewState());
	let errorMessage = $derived(viewState.error?.message ?? null);
	let loading = $state(true);
	let refreshing = $state(false);
	let assigningBotKind = $state<AdminBotKind | null>(null);
	let botActionState = $state(createAdminBotActionState());

	onMount(() => {
		let disposed = false;
		let unlisten: (() => void) | null = null;

		void refreshState({ initialLoad: true, clearActionErrorOnSuccess: true });
		void botPort.onStateChanged(() => {
			if (!disposed) {
				// Passive state events refresh data without dismissing an action failure.
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

	function projectActiveBiddingPolicy(bot: AdminBotRecord): {
		entries: BiddingSettingEntry[];
		error: string | null;
	} {
		if (!config || !bot.biddingMandate) return { entries: [], error: null };
		try {
			return {
				entries: buildActiveBiddingPolicySummary(config, bot.biddingMandate.startPolicy),
				error: null
			};
		} catch {
			return {
				entries: [],
				error: 'Active bidding authorization could not be displayed. Stop the bot and see desktop-app logs.'
			};
		}
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

	async function refreshState(
		options: { initialLoad?: boolean; clearActionErrorOnSuccess?: boolean } = {}
	): Promise<void> {
		const refresh = beginAdminBotRefresh(viewState, {
			clearActionErrorOnSuccess: options.clearActionErrorOnSuccess
		});
		viewState = refresh.state;
		const refreshRequest = refresh.request;
		const initialLoad = options.initialLoad === true;
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
			if (!isCurrentAdminBotRefresh(viewState, refreshRequest)) {
				return;
			}
			bots = visibleBots(nextBots);
			wallets = nextWallets;
			biddingCollectionCatalog = nextBiddingCollectionCatalog;
			biddingMandateSelections = syncBiddingMandateSelections(
				nextBiddingCollectionCatalog.collections,
				biddingMandateSelections
			);
			syncSelections(bots);
			viewState = finishAdminBotRefreshSuccess(viewState, refreshRequest);
		} catch (error) {
			if (isCurrentAdminBotRefresh(viewState, refreshRequest)) {
				viewState = finishAdminBotRefreshFailure(
					viewState,
					refreshRequest,
					toErrorMessage(error, 'Bot state could not be loaded. Use refresh to try again.')
				);
			}
		} finally {
			if (isCurrentAdminBotRefresh(viewState, refreshRequest)) {
				loading = false;
				refreshing = false;
			}
		}
	}

	async function handleAssignWallet(botKind: AdminBotKind): Promise<void> {
		if (
			assigningBotKind !== null ||
			isAdminBotLifecycleActionPending(botActionState, botKind)
		) {
			return;
		}
		assigningBotKind = botKind;
		viewState = beginAdminBotViewAction(viewState);
		try {
			await botPort.assignWallet(botKind, selectedWalletIds[botKind] || null);
			await refreshState({ clearActionErrorOnSuccess: true });
		} catch (error) {
			viewState = publishAdminBotActionError(
				viewState,
				toErrorMessage(
					error,
					'Wallet could not be assigned. Try again or see desktop-app logs.'
				)
			);
		} finally {
			if (assigningBotKind === botKind) {
				assigningBotKind = null;
			}
		}
	}

	async function handleStart(botKind: AdminBotKind): Promise<void> {
		if (assigningBotKind !== null) {
			return;
		}
		const started = beginAdminBotStart(botActionState, botKind);
		if (!started) {
			return;
		}
		botActionState = started.state;
		viewState = beginAdminBotViewAction(viewState);
		try {
			const biddingMandate =
				botKind === TRADING_BOT_KIND.Bidding
					? buildBiddingMandateDraft(biddingCollections, biddingMandateSelections)
					: null;
			await botPort.startBot(botKind, biddingMandate);
			if (isCurrentAdminBotAction(botActionState, started.request)) {
				await refreshState({ clearActionErrorOnSuccess: true });
			}
		} catch (error) {
			if (isCurrentAdminBotAction(botActionState, started.request)) {
				viewState = publishAdminBotActionError(
					viewState,
					toErrorMessage(
						error,
						'Bot could not be started. Try again or see desktop-app logs.'
					)
				);
			}
		} finally {
			botActionState = finishAdminBotAction(botActionState, started.request);
		}
	}

	async function handleStop(botKind: AdminBotKind): Promise<void> {
		const started = beginAdminBotStop(botActionState, botKind);
		if (!started) {
			return;
		}
		botActionState = started.state;
		viewState = beginAdminBotViewAction(viewState);
		let stopSucceeded = false;
		try {
			await botPort.stopBot(botKind);
			stopSucceeded = true;
			if (isCurrentAdminBotAction(botActionState, started.request)) {
				await refreshState({ clearActionErrorOnSuccess: true });
			}
		} catch (error) {
			if (isCurrentAdminBotAction(botActionState, started.request)) {
				viewState = publishAdminBotActionError(
					viewState,
					toErrorMessage(
						error,
						'Bot could not be stopped. Try again or see desktop-app logs.'
					)
				);
			}
		} finally {
			botActionState = finishAdminBotAction(botActionState, started.request, {
				stopSucceeded
			});
		}
	}
</script>

<AdminSectionFrame>
	<div class="admin-bots-body">
		<div class="admin-bots-inlay">
			<section class="runtime-section">
				<div class="runtime-controls">
					<button
						type="button"
						onclick={() => void refreshState({ clearActionErrorOnSuccess: true })}
						disabled={loading || refreshing}
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
						{@const activePolicyProjection = projectActiveBiddingPolicy(bot)}
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
										<span class="runtime-v">{formatAdminBotState(bot.state)}</span>
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

							{#if bot.botKind === TRADING_BOT_KIND.Bidding && bot.biddingMandate}
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
									{#if activePolicyProjection.error}
										<p class="runtime-error" role="alert">{activePolicyProjection.error}</p>
									{:else}
										<dl class="admin-setting-list active-bidding-policy">
											{#each activePolicyProjection.entries as entry (entry.key)}
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
									{/if}
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

							{#if bot.botKind === TRADING_BOT_KIND.Bidding}
								{@const mandateEditingDisabled = assigningBotKind !== null ||
									isAdminBotLifecycleActionPending(botActionState, bot.botKind) ||
									botActive}
								<section
									class="runtime-section bidding-start-policy"
									aria-label="Bidding settings"
								>
									<h3>
										{botActive && bot.biddingMandate
											? 'next-start bidding settings'
											: 'bidding settings'}
									</h3>
									{#if biddingSettingsProjection.error}
										<p class="runtime-error" role="alert">{biddingSettingsProjection.error}</p>
									{/if}
									<dl class="admin-setting-list">
										{#each biddingSettingsProjection.entries as entry (entry.key)}
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
										{bot.biddingMandate
											? 'next-start bidding authorization request'
											: 'bidding authorization request'}
										{#if biddingCollectionCatalog}
											· {formatBiddingChainIdentity(biddingCollectionCatalog.chain)}
										{/if}
									</h3>
									{#if biddingCollections.length === 0}
										<span class="muted">no collections ready for bidding authorization</span>
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
										disabled={assigningBotKind !== null ||
											isAdminBotLifecycleActionPending(botActionState, bot.botKind) ||
											botActive}
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
										disabled={assigningBotKind !== null ||
											isAdminBotLifecycleActionPending(botActionState, bot.botKind) ||
											botActive}
									>
										{assigningBotKind === bot.botKind ? 'applying…' : 'apply wallet'}
									</button>
								</div>

								<div class="runtime-controls">
									<button
										type="button"
										class="action-button-negative"
										onclick={() => void handleStop(bot.botKind)}
										disabled={isAdminBotStopPending(botActionState, bot.botKind) ||
											!canStopAdminBot(botActionState, bot)}
									>
										{isAdminBotStopPending(botActionState, bot.botKind) ? 'stopping…' : 'stop'}
									</button>

									<button
										type="button"
										class="action-button-positive"
										onclick={() => void handleStart(bot.botKind)}
										disabled={assigningBotKind !== null ||
											isAdminBotLifecycleActionPending(botActionState, bot.botKind) ||
											!canStart(bot)}
									>
										{isAdminBotStartPending(botActionState, bot.botKind) &&
										!isAdminBotStopPending(botActionState, bot.botKind)
											? 'starting…'
											: 'start'}
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

	.bidding-start-policy :global(.admin-setting-label-tooltip .info-tooltip-popup) {
		/* Keep Config-owned help readable inside narrow Admin panels. */
		max-width: min(18rem, 50vw);
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
