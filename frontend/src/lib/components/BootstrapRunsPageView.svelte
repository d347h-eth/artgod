<script lang="ts">
	import { browser } from '$app/environment';
	import { goto, invalidateAll } from '$app/navigation';
	import {
		BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION
	} from '@artgod/shared/config/bootstrap';
	import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
	import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
	import type {
		ApiChain,
		ApiCollectionMediaMode,
		ApiImageCacheMode,
		ApiOpenSeaIntegrationStatus,
		ApiTokenCard,
		BootstrapContractProbeApiResponse,
		BootstrapRunsApiResponse
	} from '$lib/api-types';
	import {
		createBootstrapRun,
		probeBootstrapCollectionContract
	} from '$lib/backend-api';
	import {
		bootstrapProbeFormPatch,
		bootstrapProbeStatusLabel,
		formatByteSize,
		isBootstrapProbeableAddress,
		normalizeBootstrapAddress
	} from '$lib/bootstrap-contract-probe';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import InfoTooltip from '$lib/components/InfoTooltip.svelte';
	import TokenCardTile from '$lib/components/TokenCardTile.svelte';
	import { getTokenPreviewController } from '$lib/components/token-preview-controller';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import { TEST_IDS } from '$lib/test-ids';

	let {
		chain,
		page,
		status,
		basePath,
		openseaIntegration
	}: {
		chain: ApiChain | null;
		page: BootstrapRunsApiResponse['page'];
		status: string;
		basePath: string;
		openseaIntegration: ApiOpenSeaIntegrationStatus | null;
	} = $props();

	const statusOptions = [
		'',
		'requested',
		'queued',
		'metadata',
		'image_cache',
		'ownership',
		'backfill',
		'completed',
		'failed'
	];
	const bootstrapInputClass = 'bootstrap-control';
	const bootstrapSelectClass = 'bootstrap-control bootstrap-control-select';
	const bootstrapTextareaClass = 'bootstrap-control bootstrap-control-textarea';
	const bootstrapCheckboxClass = 'bootstrap-checkbox';
	const bootstrapPreviewMediaModes: ApiCollectionMediaMode[] = [
		{ key: COLLECTION_MEDIA_MODES.Snapshot, label: COLLECTION_MEDIA_MODES.Snapshot }
	];
	const tokenPreview = getTokenPreviewController();
	const bootstrapFieldHelp = {
		address: 'ERC721 contract address to probe and bootstrap.',
		slug: 'Local collection slug used in ArtGod URLs.',
		openseaSlug: 'Optional OpenSea collection slug for snapshot seeding.',
		metadataMode: 'Best effort skips failed token metadata. Strict fails the run on metadata errors.',
		probeStatus: 'Current backend contract probe result for this address.',
		probeError: 'Probe failure returned by the backend.',
		erc721Interface: 'ERC165 ERC721 support check.',
		enumerableInterface: 'ERC165 ERC721Enumerable support check.',
		contractTotalSupply: 'totalSupply() returned by the contract, when available.',
		previewToken: 'Token selected by tokenByIndex or fallback token checks.',
		tokenUriPayloadSize: 'Fetched tokenURI metadata payload size for the preview token.',
		projectedTokenUriPayloadSize: 'Approximate metadata payload storage for the collection.',
		originalImageFileSize: 'Fetched image file size from the tokenURI image property.',
		projectedOriginalImageFileSize: 'Approximate original image storage for the collection.',
		probeWarnings: 'Probe fallbacks or incomplete checks that may need review.',
		manualEditing: 'Unlock probe-derived fields. Use only if the probe result is wrong.',
		supportsEnumerable: 'Controls whether bootstrap enumerates tokens through tokenByIndex.',
		imageCacheMode: 'Controls token card image caching after bootstrap.',
		imageMaxDimension: 'Maximum cached image width or height in pixels.',
		manualMode: 'Manual token scope used when enumerable support is unavailable.',
		tokenIds: 'Explicit token IDs to bootstrap, separated by commas or whitespace.',
		startTokenId: 'First token ID for manual range bootstrap.',
		manualRangeTotalSupply: 'Number of tokens in the manual range.'
	} as const;

	let bootstrapSlug = $state('');
	let bootstrapAddress = $state('');
	let bootstrapOpenSeaSlug = $state('');
	let metadataMode = $state<'best_effort' | 'strict'>('best_effort');
	let supportsEnumerable = $state(false);
	let manualMode = $state<'manual_token_ids' | 'manual_range'>('manual_range');
	let manualTokenIds = $state('');
	let manualRangeStartTokenId = $state('');
	let manualRangeTotalSupply = $state('');
	let imageCacheMode = $state<ApiImageCacheMode>(IMAGE_CACHE_MODE.CacheOnce);
	let imageCacheMaxDimension = $state(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
	let manualEditingAllowed = $state(false);
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let submitSuccess = $state<string | null>(null);
	let probeStatus = $state<'idle' | 'waiting' | 'loading' | 'ready' | 'error'>('idle');
	let probeResult = $state<BootstrapContractProbeApiResponse | null>(null);
	let probeError = $state<string | null>(null);
	let probeAddress = $state<string | null>(null);
	let openSeaEnabled = $derived(openseaIntegration?.enabled === true);
	let openSeaDisabledReason = $derived(
		openseaIntegration && !openseaIntegration.enabled
			? (openseaIntegration.reason ?? 'OpenSea integration disabled')
			: null
	);
	let normalizedBootstrapAddress = $derived(normalizeBootstrapAddress(bootstrapAddress));
	let addressCanBeProbed = $derived(isBootstrapProbeableAddress(bootstrapAddress));
	let latestProbeMatchesAddress = $derived(
		probeStatus === 'ready' && probeAddress === normalizedBootstrapAddress
	);
	let submitDisabled = $derived(
		submitting ||
			!chain ||
			!addressCanBeProbed ||
			!latestProbeMatchesAddress ||
			probeStatus === 'waiting' ||
			probeStatus === 'loading'
	);
	let probeControlledDisabled = $derived(
		probeStatus === 'ready' && probeResult !== null && latestProbeMatchesAddress && !manualEditingAllowed
	);
	let firstTokenCard = $derived(firstTokenPreviewCard());

	$effect(() => {
		if (!browser) return;
		const chainSlug = chain?.slug ?? null;
		const address = normalizedBootstrapAddress;
		if (!chainSlug || !isBootstrapProbeableAddress(address)) {
			probeStatus = 'idle';
			probeResult = null;
			probeError = null;
			probeAddress = null;
			return;
		}

		probeStatus = 'waiting';
		probeResult = null;
		probeAddress = null;
		probeError = null;
		manualEditingAllowed = false;
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void (async () => {
				probeStatus = 'loading';
				try {
					const result = await probeBootstrapCollectionContract(fetch, chainSlug, address);
					if (cancelled) return;
					probeStatus = 'ready';
					probeResult = result;
					probeAddress = result.address;
					manualEditingAllowed = false;
					applyProbeResult(result);
				} catch (error) {
					if (cancelled) return;
					probeStatus = 'error';
					probeResult = null;
					probeAddress = null;
					probeError = error instanceof Error ? error.message : 'contract probe failed';
				}
			})();
		}, 450);

		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	});

	function normalizeFieldValue(value: unknown): string {
		if (typeof value === 'string') return value.trim();
		if (typeof value === 'number' && Number.isFinite(value)) {
			return String(value).trim();
		}
		return '';
	}

	function runHref(runId: number): string {
		if (!chain) return '#';
		return `/${chain.slug}/bootstrap-runs/${runId}`;
	}

	function applyProbeResult(result: BootstrapContractProbeApiResponse): void {
		const patch = bootstrapProbeFormPatch(result);
		supportsEnumerable = patch.supportsEnumerable;
		if (patch.manualMode === 'manual_range') {
			manualMode = 'manual_range';
			manualRangeStartTokenId = patch.manualRangeStartTokenId;
			manualRangeTotalSupply = patch.manualRangeTotalSupply;
		}
	}

	function probeStateLabel(): string {
		if (probeStatus === 'waiting' || probeStatus === 'loading') return 'probing';
		if (probeStatus === 'ready' && probeResult) return bootstrapProbeStatusLabel(probeResult);
		if (probeStatus === 'error') return 'probe failed';
		return '';
	}

	function interfaceLabel(value: boolean | null): string {
		if (value === true) return 'yes';
		if (value === false) return 'no';
		return 'unknown';
	}

	function firstTokenPreviewCard(): ApiTokenCard | null {
		const firstToken = probeResult?.firstToken;
		if (!firstToken?.tokenId) return null;
		return {
			tokenId: firstToken.tokenId,
			name: firstToken.name,
			image: firstToken.image,
			traitSummary: null,
			listingPrice: null,
			listingCurrency: null,
			attributes: [],
			hasMetadata: firstToken.metadataError === null,
			metadataUpdatedAt: null
		};
	}

	function firstTokenCardHref(tokenId: string): string {
		if (!chain) return '#';
		const slug = normalizeFieldValue(bootstrapSlug).toLowerCase();
		if (!slug) return '#';
		return `/${chain.slug}/${slug}/${tokenId}`;
	}

	function firstTokenLabel(): string {
		const tokenId = probeResult?.firstToken.tokenId;
		if (!tokenId) return '-';
		const name = probeResult?.firstToken.name;
		return name ? `${tokenId} / ${name}` : tokenId;
	}

	function probeSubmitGuard(address: string): string | null {
		if (!isBootstrapProbeableAddress(address)) return 'valid address is required';
		if (!latestProbeMatchesAddress) return 'contract probe must complete before queueing bootstrap';
		if (supportsEnumerable && probeResult?.enumerable.supported !== true) {
			return 'enumerable support was not confirmed';
		}
		if (!supportsEnumerable && manualMode === 'manual_range') {
			const inferred = probeResult?.suggestedInput.manualInput;
			if (
				inferred &&
				(inferred.startTokenId !== normalizeFieldValue(manualRangeStartTokenId) ||
					String(inferred.totalSupply) !== normalizeFieldValue(manualRangeTotalSupply))
			) {
				return 'scope fields must match the latest contract probe';
			}
		}
		return null;
	}

	function parseImageCacheMaxDimension(): number | null {
		const raw = normalizeFieldValue(imageCacheMaxDimension);
		if (!raw) return null;
		const parsed = Number(raw);
		if (
			!Number.isInteger(parsed) ||
			parsed < BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION ||
			parsed > BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION
		) {
			throw new Error(
				`image max dimension must be ${BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION}-${BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION}`
			);
		}
		return parsed;
	}

	function collectionHref(item: BootstrapRunsApiResponse['page']['items'][number]): string {
		if (!chain) return '#';
		return `/${chain.slug}/${item.collection.slug}`;
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

	async function onSubmitBootstrap(event: Event): Promise<void> {
		event.preventDefault();
		submitError = null;
		submitSuccess = null;
		if (!chain) {
			submitError = 'chain is not ready';
			return;
		}

		const slug = normalizeFieldValue(bootstrapSlug).toLowerCase();
		const address = normalizeFieldValue(bootstrapAddress).toLowerCase();
		const openseaSlug = openSeaEnabled
			? normalizeFieldValue(bootstrapOpenSeaSlug).toLowerCase()
			: '';
		if (!slug || !address) {
			submitError = 'slug and address are required';
			return;
		}
		const probeGuardError = probeSubmitGuard(address);
		if (probeGuardError) {
			submitError = probeGuardError;
			return;
		}

		let manualInput:
			| {
					mode: 'manual_token_ids';
					tokenIds: string[];
			  }
			| {
					mode: 'manual_range';
					startTokenId: string;
					totalSupply: number;
			  }
			| undefined;

		if (!supportsEnumerable) {
			if (manualMode === 'manual_token_ids') {
				const tokenIds = manualTokenIds
					.split(/[\s,]+/)
					.map((value) => value.trim())
					.filter(Boolean);
				if (tokenIds.length === 0) {
					submitError = 'token ids are required';
					return;
				}
				manualInput = {
					mode: 'manual_token_ids',
					tokenIds
				};
			} else {
				const startTokenId = normalizeFieldValue(manualRangeStartTokenId);
				const totalSupply = Number(manualRangeTotalSupply);
				if (!startTokenId) {
					submitError = 'start token id is required';
					return;
				}
				if (!Number.isInteger(totalSupply) || totalSupply <= 0) {
					submitError = 'total supply must be a positive integer';
					return;
				}
				manualInput = {
					mode: 'manual_range',
					startTokenId,
					totalSupply
				};
			}
		}

		let imageCacheMaxDimensionValue: number | null = null;
		if (imageCacheMode !== IMAGE_CACHE_MODE.Off) {
			try {
				imageCacheMaxDimensionValue = parseImageCacheMaxDimension();
			} catch (error) {
				submitError = error instanceof Error ? error.message : 'invalid image cache setting';
				return;
			}
		}

		submitting = true;
		try {
			const result = await createBootstrapRun(fetch, chain.slug, {
				slug,
				address,
				openseaSlug: openseaSlug || undefined,
				standard: 'erc721',
				metadataMode,
				supportsEnumerable,
				manualInput,
				imageCache: {
					imageCacheMode,
					maxDimension:
						imageCacheMode === IMAGE_CACHE_MODE.Off ? null : imageCacheMaxDimensionValue
				}
			});
			submitSuccess = `bootstrap queued (run ${result.runId})`;
			await invalidateAll();
		} catch (error) {
			submitError = error instanceof Error ? error.message : 'bootstrap request failed';
		} finally {
			submitting = false;
		}
	}
</script>

{#snippet fieldLabel(label: string, help: string)}
	<span class="bootstrap-form-label-cell">
		<span>{label}</span>
		<InfoTooltip text={help} className="bootstrap-form-label-tooltip" />
	</span>
{/snippet}

<section class="panel">
	<header class="panel-header">
		<h1 class="app-title">ArtGod {APP_VERSION}</h1>
	</header>

	<ListPagesTabs chainSlug={chain?.slug ?? null} active="bootstrapping" />

	<header class="panel-header">
		<div>
			<p class="panel-subtitle">
				{#if chain}
					{chain.name} ({chain.slug} / {chain.publicChainId})
				{:else}
					Loading chain...
				{/if}
			</p>
		</div>
		<div class="status-form">
			<label for="bootstrap-run-status">status</label>
			<select id="bootstrap-run-status" name="status" onchange={applyStatusFilter}>
				{#each statusOptions as option}
					<option value={option} selected={option === status}>{option || 'all'}</option>
				{/each}
			</select>
		</div>
	</header>

	<form class="bootstrap-form bootstrap-create-form" onsubmit={onSubmitBootstrap}>
		<div class="bootstrap-create-layout">
			<div class="bootstrap-form-fields">
				{#if submitSuccess || submitError}
					<div class="bootstrap-form-feedback">
						{#if submitSuccess}
							<span class="muted">{submitSuccess}</span>
						{/if}
						{#if submitError}
							<span class="muted">{submitError}</span>
						{/if}
					</div>
				{/if}

				<div class="bootstrap-form-section">
					<label class="bootstrap-form-row">
						{@render fieldLabel('Contract address', bootstrapFieldHelp.address)}
						<input
							bind:value={bootstrapAddress}
							class={`${bootstrapInputClass} bootstrap-input-address`}
							type="text"
							name="address"
							required
						/>
					</label>
					<label class="bootstrap-form-row">
						{@render fieldLabel('Collection slug', bootstrapFieldHelp.slug)}
						<input
							bind:value={bootstrapSlug}
							class={`${bootstrapInputClass} bootstrap-input-slug`}
							type="text"
							name="slug"
							required
						/>
					</label>
					<label class="bootstrap-form-row">
						{@render fieldLabel('OpenSea slug', bootstrapFieldHelp.openseaSlug)}
						<div class="bootstrap-input-with-note">
							<input
								bind:value={bootstrapOpenSeaSlug}
								class={`${bootstrapInputClass} bootstrap-input-slug`}
								type="text"
								disabled={!openSeaEnabled}
							/>
							{#if openSeaDisabledReason}
								<span class="muted">{openSeaDisabledReason}</span>
							{/if}
						</div>
					</label>
					<label class="bootstrap-form-row">
						{@render fieldLabel('Metadata mode', bootstrapFieldHelp.metadataMode)}
						<select bind:value={metadataMode} class={`${bootstrapSelectClass} bootstrap-input-select-short`}>
							<option value="best_effort">best effort</option>
							<option value="strict">strict</option>
						</select>
					</label>
				</div>

				{#if probeStatus !== 'idle'}
					<div class="bootstrap-form-section bootstrap-probe-section">
						<div class="bootstrap-form-row">
							{@render fieldLabel('Contract probe status', bootstrapFieldHelp.probeStatus)}
							<div class="bootstrap-probe-status mono">{probeStateLabel()}</div>
						</div>
						{#if probeError}
							<div class="bootstrap-form-row">
								{@render fieldLabel('Probe error', bootstrapFieldHelp.probeError)}
								<div class="muted">{probeError}</div>
							</div>
						{/if}
						{#if probeResult}
							<div class="bootstrap-form-row">
								{@render fieldLabel('ERC721 interface', bootstrapFieldHelp.erc721Interface)}
								<div class="mono">{interfaceLabel(probeResult.erc721.supported)}</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('ERC721Enumerable interface', bootstrapFieldHelp.enumerableInterface)}
								<div class="mono">{interfaceLabel(probeResult.enumerable.supported)}</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('Contract total supply', bootstrapFieldHelp.contractTotalSupply)}
								<div class="mono">{probeResult.totalSupply.value ?? '-'}</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('Preview token', bootstrapFieldHelp.previewToken)}
								<div class="mono">{firstTokenLabel()}</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('Metadata/tokenURI payload size', bootstrapFieldHelp.tokenUriPayloadSize)}
								<div class="mono">
									{formatByteSize(probeResult.firstToken.tokenUriPayloadBytes)}
								</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('Projected metadata/tokenURI total size', bootstrapFieldHelp.projectedTokenUriPayloadSize)}
								<div class="mono">
									{formatByteSize(probeResult.storageEstimate?.projectedBytes)}
								</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('Original image file size', bootstrapFieldHelp.originalImageFileSize)}
								<div class="mono">
									{formatByteSize(probeResult.firstToken.imageBytes)}
								</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('Projected original image total size', bootstrapFieldHelp.projectedOriginalImageFileSize)}
								<div class="mono">
									{formatByteSize(probeResult.imageStorageEstimate?.projectedBytes)}
								</div>
							</div>
							{#if probeResult.suggestedInput.warnings.length > 0}
								<div class="bootstrap-form-row bootstrap-probe-warning-row">
									{@render fieldLabel('Probe warnings', bootstrapFieldHelp.probeWarnings)}
									<div class="bootstrap-probe-warnings">
										{#each probeResult.suggestedInput.warnings as warning}
											<span class="muted">{warning}</span>
										{/each}
									</div>
								</div>
							{/if}
						{/if}
					</div>
				{/if}

				{#if probeResult}
					<div class="bootstrap-form-section">
						<label class="bootstrap-form-checkbox-row bootstrap-form-row">
							{@render fieldLabel('Allow manual editing', bootstrapFieldHelp.manualEditing)}
							<div class="bootstrap-manual-edit-control">
								<input
									bind:checked={manualEditingAllowed}
									class={bootstrapCheckboxClass}
									type="checkbox"
									data-testid={TEST_IDS.BootstrapAllowManualEditing}
								/>
								<span class="muted">use only if you know what you are doing</span>
							</div>
						</label>
					</div>
				{/if}

				<div class="bootstrap-form-section">
					<label class="bootstrap-form-checkbox-row bootstrap-form-row">
						{@render fieldLabel('Use ERC721Enumerable token enumeration', bootstrapFieldHelp.supportsEnumerable)}
						<input
							bind:checked={supportsEnumerable}
							class={bootstrapCheckboxClass}
							type="checkbox"
							disabled={probeControlledDisabled}
						/>
					</label>
				</div>

				<div class="bootstrap-form-section">
					<label class="bootstrap-form-row">
						{@render fieldLabel('Image cache mode', bootstrapFieldHelp.imageCacheMode)}
						<select bind:value={imageCacheMode} class={`${bootstrapSelectClass} bootstrap-input-select-medium`}>
							<option value={IMAGE_CACHE_MODE.Off}>off</option>
							<option value={IMAGE_CACHE_MODE.CacheOnce}>cache once</option>
							<option value={IMAGE_CACHE_MODE.RefreshOnMetadata}>refresh on metadata</option>
						</select>
					</label>
					{#if imageCacheMode !== IMAGE_CACHE_MODE.Off}
						<label class="bootstrap-form-row">
							{@render fieldLabel('Cached image max dimension', bootstrapFieldHelp.imageMaxDimension)}
							<input
								bind:value={imageCacheMaxDimension}
								class={`${bootstrapInputClass} bootstrap-input-total-supply`}
								type="number"
								min={BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION}
								max={BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION}
							/>
						</label>
					{/if}
				</div>

				{#if !supportsEnumerable}
					<div class="bootstrap-form-section">
						<label class="bootstrap-form-row">
							{@render fieldLabel('Manual token scope mode', bootstrapFieldHelp.manualMode)}
							<select
								bind:value={manualMode}
								class={`${bootstrapSelectClass} bootstrap-input-select-medium`}
								disabled={probeControlledDisabled}
							>
								<option value="manual_range">start + total supply</option>
								<option value="manual_token_ids">token ids list</option>
							</select>
						</label>
						{#if manualMode === 'manual_token_ids'}
							<label class="bootstrap-form-row bootstrap-form-row-textarea">
								{@render fieldLabel('Manual token IDs', bootstrapFieldHelp.tokenIds)}
								<textarea
									bind:value={manualTokenIds}
									class={`${bootstrapTextareaClass} bootstrap-input-token-ids`}
									rows="4"
									disabled={probeControlledDisabled}
								></textarea>
							</label>
						{:else}
							<label class="bootstrap-form-row">
								{@render fieldLabel('Manual range start token ID', bootstrapFieldHelp.startTokenId)}
								<input
									bind:value={manualRangeStartTokenId}
									class={`${bootstrapInputClass} bootstrap-input-token-id`}
									type="text"
									disabled={probeControlledDisabled}
								/>
							</label>
							<label class="bootstrap-form-row">
								{@render fieldLabel('Manual range total supply', bootstrapFieldHelp.manualRangeTotalSupply)}
								<input
									bind:value={manualRangeTotalSupply}
									class={`${bootstrapInputClass} bootstrap-input-total-supply`}
									type="number"
									min="1"
									disabled={probeControlledDisabled}
								/>
							</label>
						{/if}
					</div>
				{/if}

				<div class="bootstrap-form-actions">
					<button type="submit" disabled={submitDisabled}>
						{submitting ? 'submitting...' : 'queue bootstrap'}
					</button>
				</div>
			</div>
			<aside class="bootstrap-token-card-pane" aria-label="Token image preview">
				{#if firstTokenCard}
					<div class="bootstrap-probe-token-card" data-testid={TEST_IDS.BootstrapProbeTokenCard}>
						<TokenCardTile
							{chain}
							collection={null}
							token={firstTokenCard}
							href={firstTokenCardHref(firstTokenCard.tokenId)}
							selectedMediaMode={COLLECTION_MEDIA_MODES.Snapshot}
							availableMediaModes={bootstrapPreviewMediaModes}
							{tokenPreview}
							metaLabel={firstTokenCard.name}
						/>
					</div>
				{:else}
					<div class="bootstrap-probe-media-empty muted">-</div>
				{/if}
			</aside>
		</div>
	</form>

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>run</th>
					<th>collection</th>
					<th>status</th>
					<th>metadata mode</th>
					<th>enumeration</th>
					<th>progress</th>
					<th>updated</th>
				</tr>
			</thead>
			<tbody>
				{#if page.items.length === 0}
					<tr>
						<td colspan="7" class="empty-cell">no bootstrap runs found</td>
					</tr>
				{:else}
					{#each page.items as item}
						<tr>
							<td class="mono">
								<a href={runHref(item.run.runId)}>#{item.run.runId}</a>
							</td>
							<td>
								<a href={collectionHref(item)}>{item.collection.slug}</a>
							</td>
							<td>{item.run.status}</td>
							<td>{item.run.metadataMode}</td>
							<td>{item.run.enumerationMode}</td>
							<td class="mono">
								{item.metadataTasks.succeeded}/{item.metadataTasks.total}
								{#if item.metadataTasks.failedTerminal > 0}
									<span class="muted"> failed:{item.metadataTasks.failedTerminal}</span>
								{/if}
							</td>
							<td class="mono">{item.run.updatedAt}</td>
						</tr>
					{/each}
				{/if}
			</tbody>
		</table>
	</div>

	<footer class="panel-footer">
		{#if page.nextCursor}
			<a class="button-link" href={loadMoreHref()}>load more</a>
		{:else}
			<span class="muted">end of results</span>
		{/if}
	</footer>
</section>
