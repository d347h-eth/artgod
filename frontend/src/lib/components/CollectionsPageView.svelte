<script lang="ts">
	import { goto } from '$app/navigation';
	import {
		getDefaultBlockExplorerConfig,
		type BlockExplorerConfig
	} from '@artgod/shared/config/block-explorer';
	import {
		BackendApiError,
		getBootstrapStatus,
		purgeCollection,
		startCollectionBootstrap,
		startCollectionOpenSeaSync,
		updateCollectionOpenSeaStreamIngestion
	} from '$lib/backend-api';
	import type { ApiChain, ApiCollection, ApiCollectionsPage } from '$lib/api-types';
	import KeyboardShortcutsHelp from '$lib/components/KeyboardShortcutsHelp.svelte';
	import { createKeyboardShortcutsHelpController } from '$lib/components/keyboard-shortcuts-help-controller';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import {
		COLLECTION_STATUS,
		COLLECTION_STATUSES,
		OPENSEA_COLLECTION_STATUS,
		OPENSEA_STREAM_INGESTION_STATUS,
		isOpenSeaCollectionSyncActive,
		type OpenSeaStreamIngestionStatus
	} from '@artgod/shared/types';

	let {
		chain,
		page,
		status,
		basePath,
		blockExplorer = getDefaultBlockExplorerConfig()
	}: {
		chain: ApiChain | null;
		page: ApiCollectionsPage;
		status: string;
		basePath: string;
		blockExplorer?: BlockExplorerConfig;
	} = $props();

	const COLLECTION_TABLE_ACTION = {
		StartBootstrap: 'start_bootstrap',
		StartOpenSeaSync: 'start_opensea_sync',
		PauseOpenSeaStream: 'pause_opensea_stream',
		ResumeOpenSeaStream: 'resume_opensea_stream'
	} as const;
	const statusOptions = ['', ...COLLECTION_STATUSES];
	let latestRunHrefByCollection = $state<Record<string, string | null>>({});
	let collectionActionPending = $state<string | null>(null);
	let collectionActionError = $state<string | null>(null);
	let purgeTarget = $state<ApiCollection | null>(null);
	let purgeConfirmation = $state('');
	let purgeError = $state<string | null>(null);
	let purgeSubmitting = $state(false);
	let purgedCollectionKeys = $state<Set<string>>(new Set());
	const keyboardShortcutsHelp = createKeyboardShortcutsHelpController();
	let visibleCollections = $derived(
		page.items.filter((collection) => !purgedCollectionKeys.has(collectionKey(collection)))
	);

	$effect(() => {
		if (!chain) {
			latestRunHrefByCollection = {};
			return;
		}
		const bootstrappingItems = page.items.filter(
			(item) => item.status === COLLECTION_STATUS.Bootstrapping
		);
		if (bootstrappingItems.length === 0) {
			latestRunHrefByCollection = {};
			return;
		}

		let cancelled = false;
		void (async () => {
			const entries = await Promise.all(
				bootstrappingItems.map(async (item) => {
					try {
						const response = await getBootstrapStatus(fetch, chain.slug, collectionRef(item));
						const href = response.latestRun
							? `/${chain.slug}/bootstrap-runs/${response.latestRun.runId}`
							: null;
						return [collectionKey(item), href] as const;
					} catch {
						return [collectionKey(item), null] as const;
					}
				})
			);
			if (cancelled) return;
			const next: Record<string, string | null> = {};
			for (const [key, href] of entries) {
				next[key] = href;
			}
			latestRunHrefByCollection = next;
		})();

		return () => {
			cancelled = true;
		};
	});

	function collectionKey(collection: ApiCollection): string {
		return `${collection.chainId}:${collection.collectionId}`;
	}

	function collectionRef(collection: ApiCollection): string {
		return collection.slug;
	}

	function collectionHref(collection: ApiCollection): string {
		if (!chain) return '#';
		return `/${chain.slug}/${collectionRef(collection)}`;
	}

	function actionKey(collection: ApiCollection, action: string): string {
		return `${collectionKey(collection)}:${action}`;
	}

	function currentCollectionsHref(): string {
		const query = new URLSearchParams();
		if (status) query.set('status', status);
		query.set('limit', String(page.limit));
		const suffix = query.toString();
		return suffix ? `${basePath}?${suffix}` : basePath;
	}

	function loadMoreHref(): string {
		if (!page.nextCursor) return '#';
		const query = new URLSearchParams();
		if (status) query.set('status', status);
		query.set('limit', String(page.limit));
		query.set('cursor', page.nextCursor);
		const suffix = query.toString();
		return suffix ? `${basePath}?${suffix}` : basePath;
	}

	function applyStatusFilter(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		const query = new URLSearchParams();
		const nextStatus = target.value.trim();
		if (nextStatus) query.set('status', nextStatus);
		query.set('limit', String(page.limit));
		const suffix = query.toString();
		void goto(suffix ? `${basePath}?${suffix}` : basePath);
	}

	function openPurgeModal(collection: ApiCollection): void {
		purgeTarget = collection;
		purgeConfirmation = '';
		purgeError = null;
	}

	function canStartBootstrap(collection: ApiCollection): boolean {
		return collection.status === COLLECTION_STATUS.Prepared;
	}

	function canStartOpenSeaSync(collection: ApiCollection): boolean {
		return (
			collection.status === COLLECTION_STATUS.Live &&
			Boolean(collection.openseaSlug) &&
			collection.openseaStatus !== OPENSEA_COLLECTION_STATUS.Ready &&
			!isOpenSeaCollectionSyncActive(collection.openseaStatus)
		);
	}

	function canPauseOpenSeaStream(collection: ApiCollection): boolean {
		return (
			Boolean(collection.openseaSlug) &&
			collection.openseaStreamIngestionStatus !== OPENSEA_STREAM_INGESTION_STATUS.Paused
		);
	}

	function canResumeOpenSeaStream(collection: ApiCollection): boolean {
		return (
			Boolean(collection.openseaSlug) &&
			collection.openseaStreamIngestionStatus === OPENSEA_STREAM_INGESTION_STATUS.Paused
		);
	}

	async function startBootstrap(collection: ApiCollection): Promise<void> {
		if (!chain || collectionActionPending) return;
		const pendingKey = actionKey(collection, COLLECTION_TABLE_ACTION.StartBootstrap);
		collectionActionPending = pendingKey;
		collectionActionError = null;
		try {
			const result = await startCollectionBootstrap(fetch, chain.slug, collectionRef(collection));
			await goto(`/${chain.slug}/bootstrap-runs/${result.runId}`);
		} catch (cause) {
			collectionActionError =
				cause instanceof BackendApiError ? cause.message : 'bootstrap start failed';
		} finally {
			collectionActionPending = null;
		}
	}

	async function startOpenSeaSync(collection: ApiCollection): Promise<void> {
		if (!chain || collectionActionPending) return;
		const pendingKey = actionKey(collection, COLLECTION_TABLE_ACTION.StartOpenSeaSync);
		collectionActionPending = pendingKey;
		collectionActionError = null;
		try {
			await startCollectionOpenSeaSync(fetch, chain.slug, collectionRef(collection));
			await goto(currentCollectionsHref(), { invalidateAll: true });
		} catch (cause) {
			collectionActionError =
				cause instanceof BackendApiError ? cause.message : 'OpenSea sync start failed';
		} finally {
			collectionActionPending = null;
		}
	}

	async function updateOpenSeaStreamIngestion(
		collection: ApiCollection,
		status: OpenSeaStreamIngestionStatus
	): Promise<void> {
		if (!chain || collectionActionPending) return;
		const action =
			status === OPENSEA_STREAM_INGESTION_STATUS.Paused
				? COLLECTION_TABLE_ACTION.PauseOpenSeaStream
				: COLLECTION_TABLE_ACTION.ResumeOpenSeaStream;
		const pendingKey = actionKey(collection, action);
		collectionActionPending = pendingKey;
		collectionActionError = null;
		try {
			await updateCollectionOpenSeaStreamIngestion(fetch, chain.slug, collectionRef(collection), status);
			await goto(currentCollectionsHref(), { invalidateAll: true });
		} catch (cause) {
			collectionActionError =
				cause instanceof BackendApiError ? cause.message : 'OpenSea stream update failed';
		} finally {
			collectionActionPending = null;
		}
	}

	function closePurgeModal(): void {
		if (purgeSubmitting) return;
		purgeTarget = null;
		purgeConfirmation = '';
		purgeError = null;
	}

	function canSubmitPurge(): boolean {
		return purgeConfirmation.trim().toLowerCase() === 'purge' && !purgeSubmitting;
	}

	function onPurgeBackdropClick(event: MouseEvent): void {
		if (event.target !== event.currentTarget) return;
		closePurgeModal();
	}

	function onPurgeBackdropKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Escape') return;
		closePurgeModal();
	}

	async function submitPurge(event: Event): Promise<void> {
		event.preventDefault();
		if (!chain || !purgeTarget || !canSubmitPurge()) return;
		const target = purgeTarget;
		purgeSubmitting = true;
		purgeError = null;
		try {
			await purgeCollection(fetch, chain.slug, collectionRef(target), purgeConfirmation);
			purgedCollectionKeys = new Set([...purgedCollectionKeys, collectionKey(target)]);
			purgeTarget = null;
			purgeConfirmation = '';
		} catch (cause) {
			purgeError =
				cause instanceof BackendApiError ? cause.message : 'collection purge failed';
		} finally {
			purgeSubmitting = false;
		}
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		keyboardShortcutsHelp.onWindowKeydown(event);
	}
</script>

<svelte:window onkeydown={onWindowKeydown} />

<section class="panel">
	<header class="panel-header">
		<h1 class="app-title">ArtGod {APP_VERSION}</h1>
		<KeyboardShortcutsHelp {keyboardShortcutsHelp} {blockExplorer} />
	</header>

	<ListPagesTabs chainSlug={chain?.slug ?? null} active="collections" />

	<header class="panel-header">
		<div>
			<p class="panel-subtitle">
				{#if chain}
					{chain.name} ({chain.slug} / {chain.publicChainId})
				{:else}
					Loading default chain...
				{/if}
			</p>
		</div>
		<div class="status-form">
			<label for="collection-status">status</label>
			<select id="collection-status" name="status" onchange={applyStatusFilter}>
				{#each statusOptions as option}
					<option value={option} selected={option === status}>{option || 'all'}</option>
				{/each}
			</select>
		</div>
	</header>

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>slug</th>
					<th>address</th>
					<th>status</th>
					<th>scope</th>
					<th>actions</th>
				</tr>
			</thead>
			<tbody>
				{#if visibleCollections.length === 0}
					<tr>
						<td colspan="5" class="empty-cell">no collections found</td>
					</tr>
				{:else}
					{#each visibleCollections as collection}
						<tr>
							<td>
								<a href={collectionHref(collection)}>{collection.slug}</a>
							</td>
							<td class="mono">{collection.address}</td>
							<td>
								{#if collection.status === COLLECTION_STATUS.Bootstrapping && latestRunHrefByCollection[collectionKey(collection)]}
									<a href={latestRunHrefByCollection[collectionKey(collection)] ?? '#'}>
										{collection.status}
									</a>
								{:else}
									{collection.status}
								{/if}
							</td>
							<td>{collection.tokenScope?.label ?? 'scope unavailable'}</td>
							<td>
								<div class="collection-actions">
									{#if canStartBootstrap(collection)}
										<button
											type="button"
											class="button-link"
											onclick={() => void startBootstrap(collection)}
											disabled={collectionActionPending !== null}
										>
											{collectionActionPending ===
											actionKey(collection, COLLECTION_TABLE_ACTION.StartBootstrap)
												? 'starting...'
												: 'start bootstrapping'}
										</button>
									{/if}
									{#if canStartOpenSeaSync(collection)}
										<button
											type="button"
											class="button-link"
											onclick={() => void startOpenSeaSync(collection)}
											disabled={collectionActionPending !== null}
										>
											{collectionActionPending ===
											actionKey(collection, COLLECTION_TABLE_ACTION.StartOpenSeaSync)
												? 'starting...'
												: 'start opensea sync'}
										</button>
									{/if}
									{#if canPauseOpenSeaStream(collection)}
										<button
											type="button"
											class="button-link"
											onclick={() =>
												void updateOpenSeaStreamIngestion(
													collection,
													OPENSEA_STREAM_INGESTION_STATUS.Paused
												)}
											disabled={collectionActionPending !== null}
										>
											{collectionActionPending ===
											actionKey(collection, COLLECTION_TABLE_ACTION.PauseOpenSeaStream)
												? 'pausing...'
												: 'pause opensea stream'}
										</button>
									{/if}
									{#if canResumeOpenSeaStream(collection)}
										<button
											type="button"
											class="button-link"
											onclick={() =>
												void updateOpenSeaStreamIngestion(
													collection,
													OPENSEA_STREAM_INGESTION_STATUS.Enabled
												)}
											disabled={collectionActionPending !== null}
										>
											{collectionActionPending ===
											actionKey(collection, COLLECTION_TABLE_ACTION.ResumeOpenSeaStream)
												? 'resuming...'
												: 'resume opensea stream'}
										</button>
									{/if}
									<button
										type="button"
										class="button-link collection-purge-button"
										onclick={() => openPurgeModal(collection)}
										disabled={collectionActionPending !== null}
									>
										purge
									</button>
								</div>
							</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	<footer class="panel-footer">
		{#if collectionActionError}
			<span class="collection-action-error">{collectionActionError}</span>
		{/if}
		{#if page.nextCursor}
			<a class="button-link" href={loadMoreHref()}>load more</a>
		{:else}
			<span class="muted">end of results</span>
		{/if}
	</footer>
</section>

{#if purgeTarget}
	<div
		class="collection-purge-backdrop"
		role="presentation"
		tabindex="-1"
		onclick={onPurgeBackdropClick}
		onkeydown={onPurgeBackdropKeydown}
	>
		<div
			class="collection-purge-modal"
			role="dialog"
			aria-modal="true"
			aria-labelledby="collection-purge-title"
		>
			<header class="collection-purge-header">
				<h2 id="collection-purge-title" class="panel-title">purge collection</h2>
				<button
					type="button"
					class="button-link panel-header-help-button"
					aria-label="close purge collection"
					onclick={closePurgeModal}
				>
					x
				</button>
			</header>

			<dl class="collection-purge-context">
				<div>
					<dt>collection</dt>
					<dd>{purgeTarget.slug}</dd>
				</div>
				<div>
					<dt>address</dt>
					<dd class="mono">{purgeTarget.address}</dd>
				</div>
				{#each purgeTarget.tokenScope?.items ?? [{ label: 'scope', value: 'unavailable' }] as item}
					<div>
						<dt>{item.label}</dt>
						<dd>{item.value}</dd>
					</div>
				{/each}
			</dl>

			<p class="collection-purge-warning">
				this action will completely wipe all data related to this collection from the database and
				local media cache
			</p>

			<form class="collection-purge-form" onsubmit={submitPurge}>
				<label for="collection-purge-confirmation">type purge</label>
				<input
					id="collection-purge-confirmation"
					class="collection-purge-confirmation"
					name="confirmation"
					autocomplete="off"
					bind:value={purgeConfirmation}
				/>
				<div class="collection-purge-actions">
					<button type="submit" class="button-link collection-purge-button" disabled={!canSubmitPurge()}>
						{purgeSubmitting ? 'purging' : 'purge'}
					</button>
				</div>
				{#if purgeError}
					<p class="collection-purge-error">{purgeError}</p>
				{/if}
			</form>
		</div>
	</div>
{/if}

<style>
	.collection-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		align-items: center;
	}

	.collection-purge-button {
		border-color: var(--c-pink);
		color: var(--c-pink);
	}

	.collection-action-error {
		color: var(--c-pink);
	}

	.collection-purge-backdrop {
		position: fixed;
		inset: 0;
		z-index: 140;
		background: color-mix(in srgb, var(--c-bg) 78%, transparent);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1.5rem;
	}

	.collection-purge-modal {
		width: min(35rem, 92vw);
		max-height: 90vh;
		overflow: auto;
		border: 1px solid var(--c-blue);
		background: var(--c-bg);
		padding: 1rem;
		display: grid;
		gap: 1rem;
	}

	.collection-purge-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
	}

	.collection-purge-context {
		display: grid;
		grid-template-columns: minmax(6.5rem, max-content) minmax(0, 1fr);
		gap: 0.45rem 0.9rem;
		margin: 0;
		padding: 0.75rem 0;
		border-top: 1px solid var(--c-blue);
		border-bottom: 1px solid var(--c-blue);
	}

	.collection-purge-context div {
		display: contents;
	}

	.collection-purge-context dt {
		color: var(--c-sand);
		text-transform: uppercase;
		font-size: 0.72rem;
		letter-spacing: 0.05em;
	}

	.collection-purge-context dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--c-ice);
	}

	.collection-purge-warning,
	.collection-purge-error {
		margin: 0;
	}

	.collection-purge-warning,
	.collection-purge-error {
		color: var(--c-pink);
	}

	.collection-purge-warning {
		border-left: 2px solid var(--c-pink);
		padding-left: 0.75rem;
		line-height: 1.35;
	}

	.collection-purge-form {
		display: grid;
		grid-template-columns: max-content max-content;
		gap: 0.65rem 0.8rem;
		align-items: center;
		justify-items: start;
		width: fit-content;
		max-width: 100%;
	}

	.collection-purge-form label {
		font-size: 0.75rem;
		text-transform: uppercase;
		color: var(--c-sand);
	}

	.collection-purge-confirmation {
		width: 14rem;
		max-width: 100%;
		background: var(--c-bg);
		color: var(--c-ice);
		border: 1px solid var(--c-blue);
		padding: 0.25rem 0.45rem;
		font-family: inherit;
		font-size: 0.78rem;
		line-height: 1.2;
	}

	.collection-purge-confirmation:focus {
		outline: none;
		border-color: var(--c-cyan);
	}

	.collection-purge-actions {
		display: flex;
		gap: 0.5rem;
		grid-column: 2;
	}

	.collection-purge-error {
		grid-column: 1 / -1;
	}

	@media (max-width: 420px) {
		.collection-purge-form {
			grid-template-columns: minmax(0, 1fr);
		}

		.collection-purge-actions {
			grid-column: 1;
		}
	}
</style>
