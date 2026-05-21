<script lang="ts">
	import { browser } from '$app/environment';
	import { goto, invalidateAll } from '$app/navigation';
	import {
		BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION
	} from '@artgod/shared/config/bootstrap';
	import type {
		ApiChain,
		ApiOpenSeaIntegrationStatus,
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
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import {
		resolveTokenMediaIframeSource,
		tokenMediaTitle,
		type TokenMediaIframeSource
	} from '$lib/token-media';

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

	let bootstrapSlug = $state('');
	let bootstrapAddress = $state('');
	let bootstrapOpenSeaSlug = $state('');
	let metadataMode = $state<'best_effort' | 'strict'>('best_effort');
	let supportsEnumerable = $state(false);
	let manualMode = $state<'manual_token_ids' | 'manual_range'>('manual_range');
	let manualTokenIds = $state('');
	let manualRangeStartTokenId = $state('');
	let manualRangeTotalSupply = $state('');
	let imageCacheEnabled = $state(true);
	let imageCacheMaxDimension = $state(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
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
	let firstTokenIframeSource = $derived(firstTokenMediaSource());

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
		probeError = null;
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

	function firstTokenMediaSource(): TokenMediaIframeSource | null {
		const firstToken = probeResult?.firstToken;
		if (!firstToken?.tokenId) return null;
		return resolveTokenMediaIframeSource(
			firstToken.animationUrl,
			firstToken.image,
			tokenMediaTitle(firstToken.tokenId)
		);
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
		if (imageCacheEnabled) {
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
					enabled: imageCacheEnabled,
					maxDimension: imageCacheEnabled ? imageCacheMaxDimensionValue : null
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

	<form class="bootstrap-form" onsubmit={onSubmitBootstrap}>
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
					<span>address</span>
					<input
						bind:value={bootstrapAddress}
						class={`${bootstrapInputClass} bootstrap-input-address`}
						type="text"
						name="address"
						required
					/>
				</label>
				<label class="bootstrap-form-row">
					<span>slug</span>
					<input
						bind:value={bootstrapSlug}
						class={`${bootstrapInputClass} bootstrap-input-slug`}
						type="text"
						name="slug"
						required
					/>
				</label>
				<label class="bootstrap-form-row">
					<span>opensea slug</span>
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
					<span>metadata mode</span>
					<select bind:value={metadataMode} class={`${bootstrapSelectClass} bootstrap-input-select-short`}>
						<option value="best_effort">best effort</option>
						<option value="strict">strict</option>
					</select>
				</label>
			</div>

			{#if probeStatus !== 'idle'}
				<div class="bootstrap-form-section bootstrap-probe-section">
					<div class="bootstrap-form-row">
						<span class="bootstrap-form-label">contract probe</span>
						<div class="bootstrap-probe-status mono">{probeStateLabel()}</div>
					</div>
					{#if probeError}
						<div class="bootstrap-form-row">
							<span class="bootstrap-form-label">error</span>
							<div class="muted">{probeError}</div>
						</div>
					{/if}
					{#if probeResult}
						<div class="bootstrap-probe-grid">
							<div class="bootstrap-probe-facts">
								<div class="bootstrap-form-row">
									<span class="bootstrap-form-label">erc721</span>
									<div class="mono">{interfaceLabel(probeResult.erc721.supported)}</div>
								</div>
								<div class="bootstrap-form-row">
									<span class="bootstrap-form-label">enumerable</span>
									<div class="mono">{interfaceLabel(probeResult.enumerable.supported)}</div>
								</div>
								<div class="bootstrap-form-row">
									<span class="bootstrap-form-label">total supply</span>
									<div class="mono">{probeResult.totalSupply.value ?? '-'}</div>
								</div>
								<div class="bootstrap-form-row">
									<span class="bootstrap-form-label">first token</span>
									<div class="mono">{firstTokenLabel()}</div>
								</div>
								<div class="bootstrap-form-row">
									<span class="bootstrap-form-label">tokenURI size</span>
									<div class="mono">
										{formatByteSize(probeResult.firstToken.tokenUriPayloadBytes)}
									</div>
								</div>
								<div class="bootstrap-form-row">
									<span class="bootstrap-form-label">projected size</span>
									<div class="mono">
										{formatByteSize(probeResult.storageEstimate?.projectedBytes)}
									</div>
								</div>
								<div class="bootstrap-form-row">
									<span class="bootstrap-form-label">image size</span>
									<div class="mono">
										{formatByteSize(probeResult.firstToken.imageBytes)}
									</div>
								</div>
								<div class="bootstrap-form-row">
									<span class="bootstrap-form-label">image total</span>
									<div class="mono">
										{formatByteSize(probeResult.imageStorageEstimate?.projectedBytes)}
									</div>
								</div>
								{#if probeResult.suggestedInput.warnings.length > 0}
									<div class="bootstrap-form-row bootstrap-probe-warning-row">
										<span class="bootstrap-form-label">warnings</span>
										<div class="bootstrap-probe-warnings">
											{#each probeResult.suggestedInput.warnings as warning}
												<span class="muted">{warning}</span>
											{/each}
										</div>
									</div>
								{/if}
							</div>
							<div class="bootstrap-probe-media">
								{#if firstTokenIframeSource && probeResult.firstToken.tokenId}
									<TokenMediaFrame
										iframeSource={firstTokenIframeSource}
										title={tokenMediaTitle(probeResult.firstToken.tokenId)}
										className="bootstrap-probe-media-frame"
									/>
								{:else}
									<div class="bootstrap-probe-media-empty muted">no media</div>
								{/if}
							</div>
						</div>
					{/if}
				</div>
			{/if}

			<div class="bootstrap-form-section">
				<label class="bootstrap-form-checkbox-row bootstrap-form-row">
					<span>supports enumerable</span>
					<input bind:checked={supportsEnumerable} class={bootstrapCheckboxClass} type="checkbox" />
				</label>
			</div>

			<div class="bootstrap-form-section">
				<label class="bootstrap-form-checkbox-row bootstrap-form-row">
					<span>cache token images</span>
					<input bind:checked={imageCacheEnabled} class={bootstrapCheckboxClass} type="checkbox" />
				</label>
				{#if imageCacheEnabled}
					<label class="bootstrap-form-row">
						<span>image max dimension</span>
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
						<span>manual mode</span>
						<select bind:value={manualMode} class={`${bootstrapSelectClass} bootstrap-input-select-medium`}>
							<option value="manual_range">start + total supply</option>
							<option value="manual_token_ids">token ids list</option>
						</select>
					</label>
					{#if manualMode === 'manual_token_ids'}
						<label class="bootstrap-form-row bootstrap-form-row-textarea">
							<span>token ids</span>
							<textarea
								bind:value={manualTokenIds}
								class={`${bootstrapTextareaClass} bootstrap-input-token-ids`}
								rows="4"
							></textarea>
						</label>
					{:else}
						<label class="bootstrap-form-row">
							<span>start token id</span>
							<input
								bind:value={manualRangeStartTokenId}
								class={`${bootstrapInputClass} bootstrap-input-token-id`}
								type="text"
							/>
						</label>
						<label class="bootstrap-form-row">
							<span>total supply</span>
							<input
								bind:value={manualRangeTotalSupply}
								class={`${bootstrapInputClass} bootstrap-input-total-supply`}
								type="number"
								min="1"
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
