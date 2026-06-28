<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import {
		BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION
	} from '@artgod/shared/config/bootstrap';
	import { OPENSEA_API_KEY_ENV } from '@artgod/shared/config/opensea-integration';
	import { IMAGE_CACHE_MODE } from '@artgod/shared/media/token-image-cache';
	import { COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
	import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from '@artgod/shared/types';
	import type {
		ApiChain,
		ApiCollectionCustomizationSource,
		ApiCollectionMediaMode,
		ApiImageCacheMode,
		ApiOpenSeaIntegrationStatus,
		ApiTokenCard,
		BootstrapContractProbeApiResponse,
		BootstrapOpenSeaSlugProbeApiResponse,
		BootstrapRunsApiResponse
	} from '$lib/api-types';
	import {
		createBootstrapRun,
		probeBootstrapCollectionContract,
		probeBootstrapOpenSeaSlug
	} from '$lib/backend-api';
	import {
		bootstrapProbeFormPatch,
		bootstrapProbeStatusLabel,
		contractNameToBootstrapSlug,
		formatByteSize,
		isBootstrapProbeableAddress,
		normalizeBootstrapAddress
	} from '$lib/bootstrap-contract-probe';
	import { DEFAULT_BOOTSTRAP_METADATA_MODE } from '$lib/bootstrap-metadata-mode';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import InfoTooltip from '$lib/components/InfoTooltip.svelte';
	import TokenCardTile from '$lib/components/TokenCardTile.svelte';
	import { getTokenPreviewController } from '$lib/components/token-preview-controller';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import { TEST_IDS } from '$lib/test-ids';
	import { BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS } from '@artgod/shared/bootstrap/opensea-slug-probe';

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
	// UI-local lifecycle states for the asynchronous OpenSea slug probe.
	const openSeaSlugProbeUiStatus = {
		Idle: 'idle',
		Waiting: 'waiting',
		Loading: 'loading',
		Ready: 'ready',
		Error: 'error'
	} as const;
	type OpenSeaSlugProbeUiStatus =
		(typeof openSeaSlugProbeUiStatus)[keyof typeof openSeaSlugProbeUiStatus];
	const openSeaSetupMessage =
		`Set ${OPENSEA_API_KEY_ENV} in Admin UI to sync OpenSea market/orderbook asks/offers required by built-in bidding bot features. Fully restart the app after saving the key in Admin UI.`;
	const bootstrapPreviewMediaModes: ApiCollectionMediaMode[] = [
		{ key: COLLECTION_MEDIA_MODES.Snapshot, label: COLLECTION_MEDIA_MODES.Snapshot }
	];
	const tokenPreview = getTokenPreviewController();
	const bootstrapFieldHelp = {
		address: 'ERC721 contract address to probe and bootstrap.',
		slug: 'Local collection slug used in ArtGod URLs.',
		openseaSlug:
			'Required for bidding. OpenSea event streams and orderbook require the OpenSea collection slug.',
		probeStatus: 'Current backend contract probe result for this address.',
		probeError: 'Probe failure returned by the backend.',
		erc721Interface: 'ERC165 ERC721 support check.',
		enumerableInterface: 'ERC165 ERC721Enumerable support check.',
		contractTotalSupply: 'totalSupply() returned by the contract, when available.',
		tokenUriPayloadSize: 'Fetched tokenURI metadata payload size for the preview token.',
		projectedTokenUriPayloadSize: 'Approximate metadata payload storage for the collection.',
		originalImageFileSize: 'Fetched image file size from the tokenURI image property.',
		projectedOriginalImageFileSize: 'Approximate original image storage for the collection.',
		cardImageFieldSize: 'Size of the tokenURI image field used directly when local cache is off.',
		projectedCardImageFieldSize: 'Approximate token-card image field size for the collection.',
		probeWarnings: 'Probe fallbacks or incomplete checks that may need review.',
		manualEditing: 'Unlock probe-derived fields. Use only if the probe result is wrong.',
		supportsEnumerable: 'Controls whether bootstrap enumerates tokens through tokenByIndex.',
		imageCacheMode: 'Controls token card image caching after bootstrap.',
		imageMaxDimension: 'Maximum cached image width or height in pixels.',
		imageCachePolicySource: 'Whether the current cache mode came from a collection extension or user selection.',
		imageCachePlan: 'How token cards will source images after bootstrap.',
		manualMode: 'Manual token scope used when enumerable support is unavailable.',
		tokenIds: 'Explicit token IDs to bootstrap, separated by commas or whitespace.',
		startTokenId: 'First token ID for manual range bootstrap.',
		manualRangeTotalSupply: 'Number of tokens in the manual range.'
	} as const;

	let bootstrapSlug = $state('');
	let lastAutoFilledSlug = $state<string | null>(null);
	let bootstrapAddress = $state('');
	let bootstrapOpenSeaSlug = $state('');
	let metadataMode = $state(DEFAULT_BOOTSTRAP_METADATA_MODE);
	let supportsEnumerable = $state(false);
	let manualMode = $state<'manual_token_ids' | 'manual_range'>('manual_range');
	let manualTokenIds = $state('');
	let manualRangeStartTokenId = $state('');
	let manualRangeTotalSupply = $state('');
	let imageCacheMode = $state<ApiImageCacheMode>(IMAGE_CACHE_MODE.CacheOnce);
	let imageCacheMaxDimension = $state(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
	let imageCachePolicySource = $state<ApiCollectionCustomizationSource>(
		COLLECTION_CUSTOMIZATION_SOURCE_KIND.User
	);
	let imageCachePolicyExtensionKey = $state<string | null>(null);
	let manualEditingAllowed = $state(false);
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let probeStatus = $state<'idle' | 'waiting' | 'loading' | 'ready' | 'error'>('idle');
	let probeResult = $state<BootstrapContractProbeApiResponse | null>(null);
	let probeError = $state<string | null>(null);
	let probeAddress = $state<string | null>(null);
	let openSeaSlugProbeStatus = $state<OpenSeaSlugProbeUiStatus>(
		openSeaSlugProbeUiStatus.Idle
	);
	let openSeaSlugProbeResult = $state<BootstrapOpenSeaSlugProbeApiResponse | null>(null);
	let openSeaSlugProbeError = $state<string | null>(null);
	let openSeaSlugProbeAddress = $state<string | null>(null);
	let lastAutoFilledOpenSeaSlug: string | null = null;
	let openSeaSlugWasAutoFilled = false;
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
	let latestOpenSeaSlugProbeMatchesAddress = $derived(
		openSeaSlugProbeStatus === openSeaSlugProbeUiStatus.Ready &&
			openSeaSlugProbeAddress === normalizedBootstrapAddress
	);
	let imageCacheExtensionControlledDisabled = $derived(
		probeStatus === 'ready' &&
			probeResult !== null &&
			latestProbeMatchesAddress &&
			imageCachePolicySource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension &&
			!manualEditingAllowed
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
			resetImageCachePolicySource();
			return;
		}

		probeStatus = 'waiting';
		probeResult = null;
		probeAddress = null;
		probeError = null;
		manualEditingAllowed = false;
		resetImageCachePolicySource();
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

	$effect(() => {
		if (!browser) return;
		const chainSlug = chain?.slug ?? null;
		const address = normalizedBootstrapAddress;
		if (!chainSlug || !openSeaEnabled || !isBootstrapProbeableAddress(address)) {
			openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Idle;
			openSeaSlugProbeResult = null;
			openSeaSlugProbeError = null;
			openSeaSlugProbeAddress = null;
			return;
		}

		openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Waiting;
		openSeaSlugProbeResult = null;
		openSeaSlugProbeAddress = null;
		openSeaSlugProbeError = null;
		if (openSeaSlugWasAutoFilled) {
			bootstrapOpenSeaSlug = '';
			lastAutoFilledOpenSeaSlug = null;
			openSeaSlugWasAutoFilled = false;
		}

		let cancelled = false;
		const timer = window.setTimeout(() => {
			void (async () => {
				openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Loading;
				try {
					const result = await probeBootstrapOpenSeaSlug(fetch, chainSlug, address);
					if (cancelled) return;
					openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Ready;
					openSeaSlugProbeResult = result;
					openSeaSlugProbeAddress = result.address;
					applyOpenSeaSlugProbeResult(result);
				} catch (error) {
					if (cancelled) return;
					openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Error;
					openSeaSlugProbeResult = null;
					openSeaSlugProbeAddress = null;
					openSeaSlugProbeError =
						error instanceof Error ? error.message : 'OpenSea slug probe failed';
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
		const normalizedBasePath = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
		return `${normalizedBasePath}/${runId}`;
	}

	function applyProbeResult(result: BootstrapContractProbeApiResponse): void {
		const patch = bootstrapProbeFormPatch(result);
		const slugSuggestion = contractNameToBootstrapSlug(result.contractName);
		if (slugSuggestion && (!bootstrapSlug.trim() || bootstrapSlug === lastAutoFilledSlug)) {
			bootstrapSlug = slugSuggestion;
			lastAutoFilledSlug = slugSuggestion;
		}
		supportsEnumerable = patch.supportsEnumerable;
		if (patch.manualMode === 'manual_range') {
			manualMode = 'manual_range';
			manualRangeStartTokenId = patch.manualRangeStartTokenId;
			manualRangeTotalSupply = patch.manualRangeTotalSupply;
		}
		applyProbeImageCacheSuggestion(result.imageCacheSuggestion);
	}

	function applyOpenSeaSlugProbeResult(result: BootstrapOpenSeaSlugProbeApiResponse): void {
		if (
			result.status !== BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found ||
			!result.slug ||
			result.address !== normalizedBootstrapAddress
		) {
			return;
		}
		if (!bootstrapOpenSeaSlug.trim() || bootstrapOpenSeaSlug === lastAutoFilledOpenSeaSlug) {
			bootstrapOpenSeaSlug = result.slug;
			lastAutoFilledOpenSeaSlug = result.slug;
			openSeaSlugWasAutoFilled = true;
		}
	}

	function onOpenSeaSlugInput(): void {
		openSeaSlugWasAutoFilled = false;
	}

	function probeStateLabel(): string {
		if (probeStatus === 'waiting' || probeStatus === 'loading') return 'probing';
		if (probeStatus === 'ready' && probeResult) return bootstrapProbeStatusLabel(probeResult);
		if (probeStatus === 'error') return 'probe failed';
		return '';
	}

	function openSeaSlugProbeMessage(): string | null {
		if (openSeaDisabledReason) {
			return `${openSeaDisabledReason}. ${openSeaSetupMessage}`;
		}
		if (!openSeaEnabled) {
			return openSeaSetupMessage;
		}
		if (
			openSeaSlugProbeStatus === openSeaSlugProbeUiStatus.Waiting ||
			openSeaSlugProbeStatus === openSeaSlugProbeUiStatus.Loading
		) {
			return 'probing OpenSea slug';
		}
		if (openSeaSlugProbeStatus === openSeaSlugProbeUiStatus.Error) {
			return openSeaSlugProbeError;
		}
		if (
			openSeaSlugProbeStatus === openSeaSlugProbeUiStatus.Ready &&
			latestOpenSeaSlugProbeMatchesAddress &&
			openSeaSlugProbeResult
		) {
			if (openSeaSlugProbeResult.status === BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found) {
				return 'OpenSea slug found from contract address';
			}
			if (openSeaSlugProbeResult.status === BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Disabled) {
				return `${openSeaSlugProbeResult.reason ?? 'OpenSea integration disabled'}. ${openSeaSetupMessage}`;
			}
			if (openSeaSlugProbeResult.status === BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing) {
				return (
					openSeaSlugProbeResult.reason ??
					'No OpenSea slug found for this contract; enter it manually if needed'
				);
			}
		}
		return null;
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
			marketplaceBiddingSupported: true,
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

	function applyProbeImageCacheSuggestion(
		suggestion: BootstrapContractProbeApiResponse['imageCacheSuggestion']
	): void {
		imageCachePolicySource = suggestion.selectedSource;
		imageCachePolicyExtensionKey = suggestion.extensionKey;
		imageCacheMode = suggestion.config.imageCacheMode;
		imageCacheMaxDimension = imageCacheMaxDimensionInputValue(suggestion.config.maxDimension);
	}

	function resetImageCachePolicySource(): void {
		imageCachePolicySource = COLLECTION_CUSTOMIZATION_SOURCE_KIND.User;
		imageCachePolicyExtensionKey = null;
	}

	function markImageCacheUserSelected(): void {
		resetImageCachePolicySource();
	}

	function imageCacheMaxDimensionInputValue(value: number | null): string {
		return value === null ? '' : String(value);
	}

	function parseImageCacheMode(value: string): ApiImageCacheMode {
		if (
			value === IMAGE_CACHE_MODE.Off ||
			value === IMAGE_CACHE_MODE.CacheOnce ||
			value === IMAGE_CACHE_MODE.RefreshOnMetadata
		) {
			return value;
		}
		return IMAGE_CACHE_MODE.CacheOnce;
	}

	function onImageCacheModeChange(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		imageCacheMode = parseImageCacheMode(target.value);
		if (imageCacheMode !== IMAGE_CACHE_MODE.Off && !normalizeFieldValue(imageCacheMaxDimension)) {
			imageCacheMaxDimension = String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION);
		}
		markImageCacheUserSelected();
	}

	function onImageCacheMaxDimensionInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		imageCacheMaxDimension = target.value;
		markImageCacheUserSelected();
	}

	function imageCachePolicySourceLabel(): string {
		if (imageCachePolicySource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension) {
			return imageCachePolicyExtensionKey
				? `extension-defined (${imageCachePolicyExtensionKey})`
				: 'extension-defined';
		}
		return 'user-defined';
	}

	function imageCacheDimensionPlanLabel(): string {
		const raw = normalizeFieldValue(imageCacheMaxDimension);
		return raw ? `${raw}px` : 'original dimensions';
	}

	function imageCachePlanValue(): string {
		if (imageCacheMode === IMAGE_CACHE_MODE.Off) {
			return 'no cache files; cards use image field';
		}
		if (imageCacheMode === IMAGE_CACHE_MODE.CacheOnce) {
			return `cache local files once; max ${imageCacheDimensionPlanLabel()}`;
		}
		return `refresh local files on metadata; max ${imageCacheDimensionPlanLabel()}`;
	}

	function imageSizeOneTokenLabel(): string {
		return imageCacheMode === IMAGE_CACHE_MODE.Off
			? 'Card image field size (1 token)'
			: 'Original image source size (1 token)';
	}

	function imageSizeFullCollectionLabel(): string {
		return imageCacheMode === IMAGE_CACHE_MODE.Off
			? 'Est. card image field size (full collection)'
			: 'Est. source images size (full collection)';
	}

	function imageSizeOneTokenHelp(): string {
		return imageCacheMode === IMAGE_CACHE_MODE.Off
			? bootstrapFieldHelp.cardImageFieldSize
			: bootstrapFieldHelp.originalImageFileSize;
	}

	function imageSizeFullCollectionHelp(): string {
		return imageCacheMode === IMAGE_CACHE_MODE.Off
			? bootstrapFieldHelp.projectedCardImageFieldSize
			: bootstrapFieldHelp.projectedOriginalImageFileSize;
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
					selectedSource: imageCachePolicySource,
					imageCacheMode,
					maxDimension:
						imageCacheMode === IMAGE_CACHE_MODE.Off ? null : imageCacheMaxDimensionValue
				}
			});
			await goto(runHref(result.runId));
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
				{#if submitError}
					<div class="bootstrap-form-feedback">
						<span class="muted">{submitError}</span>
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
								name="openseaSlug"
								disabled={!openSeaEnabled}
								oninput={onOpenSeaSlugInput}
							/>
							{#if openSeaSlugProbeMessage()}
								<span class="muted">{openSeaSlugProbeMessage()}</span>
							{/if}
						</div>
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
								{@render fieldLabel('Metadata size (1 token)', bootstrapFieldHelp.tokenUriPayloadSize)}
								<div class="mono">
									{formatByteSize(probeResult.firstToken.tokenUriPayloadBytes)}
								</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('Est. metadata size (full collection)', bootstrapFieldHelp.projectedTokenUriPayloadSize)}
								<div class="mono">
									{formatByteSize(probeResult.storageEstimate?.projectedBytes)}
								</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('Image cache policy source', bootstrapFieldHelp.imageCachePolicySource)}
								<div class="mono">{imageCachePolicySourceLabel()}</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel('Image cache plan', bootstrapFieldHelp.imageCachePlan)}
								<div class="mono">{imageCachePlanValue()}</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel(imageSizeOneTokenLabel(), imageSizeOneTokenHelp())}
								<div class="mono">
									{formatByteSize(probeResult.firstToken.imageBytes)}
								</div>
							</div>
							<div class="bootstrap-form-row">
								{@render fieldLabel(imageSizeFullCollectionLabel(), imageSizeFullCollectionHelp())}
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
						<select
							value={imageCacheMode}
							class={`${bootstrapSelectClass} bootstrap-input-select-medium`}
							onchange={onImageCacheModeChange}
							disabled={imageCacheExtensionControlledDisabled}
						>
							<option value={IMAGE_CACHE_MODE.Off}>off</option>
							<option value={IMAGE_CACHE_MODE.CacheOnce}>cache once</option>
							<option value={IMAGE_CACHE_MODE.RefreshOnMetadata}>refresh on metadata</option>
						</select>
					</label>
					{#if imageCacheMode !== IMAGE_CACHE_MODE.Off}
						<label class="bootstrap-form-row">
							{@render fieldLabel('Cached image max dimension', bootstrapFieldHelp.imageMaxDimension)}
							<input
								value={imageCacheMaxDimension}
								class={`${bootstrapInputClass} bootstrap-input-total-supply`}
								type="number"
								min={BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION}
								max={BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION}
								oninput={onImageCacheMaxDimensionInput}
								disabled={imageCacheExtensionControlledDisabled}
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
