<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import {
		BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION
	} from '@artgod/shared/config/bootstrap';
	import { OPENSEA_API_KEY_ENV } from '@artgod/shared/config/opensea-integration';
	import { IMAGE_CACHE_MODE, imageCacheModeLabel } from '@artgod/shared/media/token-image-cache';
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
		BootstrapImageCacheEstimateApiResponse,
		BootstrapOpenSeaSlugProbeApiResponse,
		BootstrapRunsApiResponse
	} from '$lib/api-types';
	import {
		createBootstrapRun,
		estimateBootstrapImageCache,
		probeBootstrapCollectionContract,
		probeBootstrapOpenSeaSlug
	} from '$lib/backend-api';
	import {
		bootstrapProbeNeedsManualScope,
		bootstrapProbeFormPatch,
		bootstrapProbeStatusLabel,
		contractNameToBootstrapSlug,
		formatByteSize,
		isBootstrapAddressComplete,
		isBootstrapProbeableAddress,
		normalizeBootstrapAddress
	} from '$lib/bootstrap-contract-probe';
	import { DEFAULT_BOOTSTRAP_METADATA_MODE } from '$lib/bootstrap-metadata-mode';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import InfoTooltip from '$lib/components/InfoTooltip.svelte';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
	import TokenCardTile from '$lib/components/TokenCardTile.svelte';
	import { getTokenPreviewController } from '$lib/components/token-preview-controller';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import { TEST_IDS } from '$lib/test-ids';
	import { BOOTSTRAP_ENUMERATION_MODE } from '@artgod/shared/bootstrap/pipeline';
	import { BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS } from '@artgod/shared/bootstrap/opensea-slug-probe';

	type BootstrapManualEnumerationMode =
		| typeof BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
		| typeof BOOTSTRAP_ENUMERATION_MODE.ManualRange;

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
	// Short paste-settle delay before the guarded contract probe starts.
	const contractProbeDelayMs = 150;
	// Debounce delay before image-cache plan calculations use a numeric draft.
	const imageCacheDimensionCommitDelayMs = 450;
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
	type OpenSeaSlugProbeRequest = Parameters<typeof probeBootstrapOpenSeaSlug>[2];
	const imageCacheEstimateUiStatus = {
		Idle: 'idle',
		Loading: 'loading',
		Ready: 'ready',
		Error: 'error'
	} as const;
	type ImageCacheEstimateUiStatus =
		(typeof imageCacheEstimateUiStatus)[keyof typeof imageCacheEstimateUiStatus];
	const openSeaSlugProbeFormId = 'bootstrap-opensea-slug-probe-form';
	const imageSourceProbeFormId = 'bootstrap-image-source-probe-form';
	const openSeaSetupMessage =
		`Set ${OPENSEA_API_KEY_ENV} in Admin UI to sync OpenSea market/orderbook asks/offers required by built-in bidding bot features. Fully restart the app after saving the key in Admin UI.`;
	const imageCachePreviewMessage =
		'This preview was generated with the selected cache settings. If it looks wrong or does not render, choose caching: off.';
	const manualScopeProbeMessage =
		'The probe could not confirm the collection supply. This usually means the collection is on a shared contract. Enable manual editing below, then set the manual scope and supply for this collection.';
	const bootstrapPreviewMediaModes: ApiCollectionMediaMode[] = [
		{ key: COLLECTION_MEDIA_MODES.Snapshot, label: COLLECTION_MEDIA_MODES.Snapshot }
	];
	const tokenPreview = getTokenPreviewController();
	const bootstrapFieldHelp = {
		address: 'ERC721 contract address to probe and bootstrap.',
		imageSourceField: 'Metadata field used as the original token image source.',
		slug: 'Local collection slug used in ArtGod URLs.',
		openseaSlug:
			'Required for bidding. OpenSea event streams and orderbook require the OpenSea collection slug.',
		probeStatus: 'Current backend contract probe result for this address.',
		probeError: 'Probe failure returned by the backend.',
		standard: 'Collection standard used for this bootstrap run.',
		erc721Interface: 'ERC165 ERC721 support check.',
		enumerableInterface: 'ERC165 ERC721Enumerable support check.',
		contractTotalSupply: 'totalSupply() returned by the contract, when available.',
		firstTokenId: 'Sample token ID used by the contract probe.',
		firstTokenSource: 'Probe path used to find the sample token.',
		tokenUriPayloadSize: 'Fetched tokenURI metadata payload size for the preview token.',
		projectedTokenUriPayloadSize: 'Approximate metadata payload storage for the collection.',
		originalImageFileSize: 'Fetched image file size from the tokenURI image property.',
		originalImageDimensions: 'Original image dimensions from the contract probe sample token.',
		projectedOriginalImageFileSize: 'Approximate original image storage for the collection.',
		imageCacheSampleOutputSize: 'Sample local image-cache file size for the selected cache settings.',
		imageCacheSampleOutputDimensions: 'Sample local image-cache dimensions for the selected cache settings.',
		projectedImageCacheOutputSize: 'Approximate local image-cache disk storage for the collection.',
		cardImageFieldSize: 'Size of the tokenURI image field used directly when local cache is off.',
		projectedCardImageFieldSize: 'Approximate token-card image field size for the collection.',
		probeWarnings: 'Probe fallbacks or incomplete checks that may need review.',
		manualEditing: 'Unlock probe-derived fields. Use only if the probe result is wrong.',
		supportsEnumerable: 'Controls whether bootstrap enumerates tokens through tokenByIndex.',
		imageCacheMode: 'Controls token card image caching after bootstrap.',
		imageMaxDimension: 'Maximum cached image width or height in pixels.',
		imageCachePolicySource: 'Whether the current cache mode came from a collection extension or user selection.',
		imageCachePlan: 'How token cards will source images after bootstrap.',
		imageCacheEstimate: 'Most recent image cache estimate result for the selected cache settings.',
		manualMode: 'Manual token scope used when enumerable support is unavailable.',
		tokenIds: 'Explicit token IDs to bootstrap, separated by commas or whitespace.',
		startTokenId: 'First token ID for manual range bootstrap.',
		manualRangeTotalSupply: 'Number of tokens in the manual range.'
	} as const;

	let bootstrapSlug = $state('');
	let collectionSlugInputElement = $state<HTMLInputElement | null>(null);
	let collectionSlugInputHasValue = $state(false);
	let lastAutoFilledSlug = $state<string | null>(null);
	let bootstrapAddress = $state('');
	let imageSourceField = $state('');
	let imageSourceFieldInputElement = $state<HTMLInputElement | null>(null);
	let imageSourceFieldDirty = $state(false);
	let bootstrapOpenSeaSlug = $state('');
	let openSeaSlugInputElement = $state<HTMLInputElement | null>(null);
	let openSeaSlugInputHasValue = $state(false);
	let metadataMode = $state(DEFAULT_BOOTSTRAP_METADATA_MODE);
	let supportsEnumerable = $state(false);
	let manualMode = $state<BootstrapManualEnumerationMode>(
		BOOTSTRAP_ENUMERATION_MODE.ManualRange
	);
	let manualTokenIds = $state('');
	let manualRangeStartTokenId = $state('');
	let manualRangeTotalSupply = $state('');
	let imageCacheMode = $state<ApiImageCacheMode>(IMAGE_CACHE_MODE.CacheOnce);
	let imageCacheMaxDimension = $state(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
	let imageCacheMaxDimensionDraft = $state(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
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
	let openSeaSlugProbeRequestedSlug = $state<string | null>(null);
	let imageCacheEstimateStatus = $state<ImageCacheEstimateUiStatus>(
		imageCacheEstimateUiStatus.Idle
	);
	let imageCacheEstimateResult = $state<BootstrapImageCacheEstimateApiResponse | null>(null);
	let imageCacheEstimateError = $state<string | null>(null);
	let lastAutoFilledOpenSeaSlug: string | null = null;
	let openSeaSlugWasAutoFilled = false;
	let contractProbeTimer: number | null = null;
	let imageCacheDimensionTimer: number | null = null;
	let contractProbeRequestId = 0;
	let openSeaSlugProbeRequestId = 0;
	let imageCacheEstimateRequestId = 0;
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
	let contractProbePending = $derived(probeStatus === 'waiting' || probeStatus === 'loading');
	let imageSourceFieldSectionVisible = $derived(
		(probeAddress === normalizedBootstrapAddress && probeResult !== null) ||
			(contractProbePending && imageSourceFieldDirty)
	);
	let imageSourceFieldResolved = $derived(isImageSourceFieldResolved());
	let imageSourceProbeButtonVisible = $derived(
		imageSourceFieldSectionVisible && !imageSourceFieldResolved && !contractProbePending
	);
	let formDetailsReady = $derived(
		latestProbeMatchesAddress && probeResult !== null && imageSourceFieldResolved
	);
	let probeStatusSectionVisible = $derived(resolveProbeStatusSectionVisible());
	let openSeaSlugProbePending = $derived(
		openSeaSlugProbeStatus === openSeaSlugProbeUiStatus.Waiting ||
			openSeaSlugProbeStatus === openSeaSlugProbeUiStatus.Loading
	);
	let imageCacheEstimatePending = $derived(
		imageCacheEstimateStatus === imageCacheEstimateUiStatus.Loading
	);
	let imageCacheEstimateReady = $derived(
		imageCacheEstimateStatus === imageCacheEstimateUiStatus.Ready &&
			imageCacheEstimateResult !== null
	);
	let imageCacheEstimateFailed = $derived(
		imageCacheEstimateStatus === imageCacheEstimateUiStatus.Error
	);
	let imageCacheEstimateCanRun = $derived(canRunImageCacheEstimate());
	let openSeaSlugResolved = $derived(isOpenSeaSlugResolved());
	let openSeaSlugIncorrect = $derived(isOpenSeaSlugIncorrect());
	let openSeaBiddingUnavailableMessage = $derived(resolveOpenSeaBiddingUnavailableMessage());
	let queueBootstrapBlockers = $derived(resolveQueueBootstrapBlockers());
	let submitDisabled = $derived(submitting || queueBootstrapBlockers.length > 0);
	let probeControlledDisabled = $derived(
		formDetailsReady && !manualEditingAllowed
	);
	let imageCacheExtensionControlledDisabled = $derived(
		formDetailsReady &&
			imageCachePolicySource === COLLECTION_CUSTOMIZATION_SOURCE_KIND.Extension &&
			!manualEditingAllowed
	);
	let firstTokenCard = $derived(firstTokenPreviewCard());
	let cachedTokenCard = $derived(cachedTokenPreviewCard());

	onDestroy(() => {
		cancelContractProbeTimer();
		cancelImageCacheDimensionTimer();
		contractProbeRequestId += 1;
		openSeaSlugProbeRequestId += 1;
		imageCacheEstimateRequestId += 1;
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

	function cancelContractProbeTimer(): void {
		if (!contractProbeTimer || !browser) return;
		window.clearTimeout(contractProbeTimer);
		contractProbeTimer = null;
	}

	function cancelImageCacheDimensionTimer(): void {
		if (!imageCacheDimensionTimer || !browser) return;
		window.clearTimeout(imageCacheDimensionTimer);
		imageCacheDimensionTimer = null;
	}

	function hasStartedBootstrapSession(): boolean {
		return (
			probeStatus !== 'idle' ||
			probeResult !== null ||
			probeAddress !== null ||
			imageSourceField.trim().length > 0 ||
			imageSourceFieldDirty ||
			openSeaSlugProbeStatus !== openSeaSlugProbeUiStatus.Idle ||
			bootstrapSlug.trim().length > 0 ||
			bootstrapOpenSeaSlug.trim().length > 0 ||
			manualEditingAllowed
		);
	}

	function resetBootstrapSession(nextAddress: string): void {
		cancelContractProbeTimer();
		cancelImageCacheDimensionTimer();
		contractProbeRequestId += 1;
		openSeaSlugProbeRequestId += 1;
		bootstrapAddress = nextAddress;
		setImageSourceFieldValue('');
		imageSourceFieldDirty = false;
		setCollectionSlugInputValue('');
		lastAutoFilledSlug = null;
		setOpenSeaSlugInputValue('');
		openSeaSlugInputHasValue = false;
		lastAutoFilledOpenSeaSlug = null;
		openSeaSlugWasAutoFilled = false;
		metadataMode = DEFAULT_BOOTSTRAP_METADATA_MODE;
		supportsEnumerable = false;
		manualMode = BOOTSTRAP_ENUMERATION_MODE.ManualRange;
		manualTokenIds = '';
		manualRangeStartTokenId = '';
		manualRangeTotalSupply = '';
		imageCacheMode = IMAGE_CACHE_MODE.CacheOnce;
		setImageCacheMaxDimensionValue(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
		resetImageCachePolicySource();
		manualEditingAllowed = false;
		submitError = null;
		probeStatus = 'idle';
		probeResult = null;
		probeError = null;
		probeAddress = null;
		resetOpenSeaSlugProbeState();
		resetImageCacheEstimateState();
	}

	function resetFormBelowImageSourceField(): void {
		openSeaSlugProbeRequestId += 1;
		imageCacheEstimateRequestId += 1;
		setCollectionSlugInputValue('');
		lastAutoFilledSlug = null;
		setOpenSeaSlugInputValue('');
		openSeaSlugInputHasValue = false;
		lastAutoFilledOpenSeaSlug = null;
		openSeaSlugWasAutoFilled = false;
		metadataMode = DEFAULT_BOOTSTRAP_METADATA_MODE;
		supportsEnumerable = false;
		manualMode = BOOTSTRAP_ENUMERATION_MODE.ManualRange;
		manualTokenIds = '';
		manualRangeStartTokenId = '';
		manualRangeTotalSupply = '';
		imageCacheMode = IMAGE_CACHE_MODE.CacheOnce;
		setImageCacheMaxDimensionValue(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
		resetImageCachePolicySource();
		manualEditingAllowed = false;
		submitError = null;
		resetOpenSeaSlugProbeState();
		resetImageCacheEstimateState();
	}

	function resetOpenSeaSlugProbeState(): void {
		openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Idle;
		openSeaSlugProbeResult = null;
		openSeaSlugProbeError = null;
		openSeaSlugProbeAddress = null;
		openSeaSlugProbeRequestedSlug = null;
	}

	function resetImageCacheEstimateState(): void {
		imageCacheEstimateRequestId += 1;
		imageCacheEstimateStatus = imageCacheEstimateUiStatus.Idle;
		imageCacheEstimateResult = null;
		imageCacheEstimateError = null;
	}

	function setImageCacheMaxDimensionValue(value: string): void {
		imageCacheMaxDimension = value;
		imageCacheMaxDimensionDraft = value;
	}

	function setCollectionSlugInputValue(value: string): void {
		bootstrapSlug = value;
		if (collectionSlugInputElement) collectionSlugInputElement.value = value;
		collectionSlugInputHasValue = normalizeFieldValue(value).length > 0;
	}

	function readCollectionSlugInputValue(): string {
		return normalizeFieldValue(
			collectionSlugInputElement?.value ?? bootstrapSlug
		).toLowerCase();
	}

	function setImageSourceFieldValue(value: string): void {
		imageSourceField = value;
		if (imageSourceFieldInputElement) imageSourceFieldInputElement.value = value;
	}

	function readImageSourceFieldInputValue(): string {
		return normalizeFieldValue(imageSourceFieldInputElement?.value ?? imageSourceField);
	}

	function onCollectionSlugInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		collectionSlugInputHasValue = normalizeFieldValue(target.value).length > 0;
	}

	function setOpenSeaSlugInputValue(value: string): void {
		bootstrapOpenSeaSlug = value;
		if (openSeaSlugInputElement) openSeaSlugInputElement.value = value;
		openSeaSlugInputHasValue = normalizeOpenSeaSlugInput(value).length > 0;
	}

	function readOpenSeaSlugInputValue(): string {
		return normalizeOpenSeaSlugInput(openSeaSlugInputElement?.value ?? bootstrapOpenSeaSlug);
	}

	function onBootstrapAddressInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		const nextAddress = target.value;
		if (hasStartedBootstrapSession()) {
			resetBootstrapSession(nextAddress);
		} else {
			bootstrapAddress = nextAddress;
			submitError = null;
		}
		maybeStartContractProbe(nextAddress);
	}

	function onBootstrapAddressFocus(event: FocusEvent): void {
		if (!latestProbeMatchesAddress) return;
		const target = event.currentTarget;
		if (target instanceof HTMLInputElement) target.select();
	}

	function onImageSourceFieldInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		cancelContractProbeTimer();
		contractProbeRequestId += 1;
		imageSourceField = target.value;
		imageSourceFieldDirty = true;
		probeError = null;
		resetFormBelowImageSourceField();
	}

	function onSubmitImageSourceProbe(event: SubmitEvent): void {
		event.preventDefault();
		const chainSlug = chain?.slug ?? null;
		const address = normalizeBootstrapAddress(bootstrapAddress);
		if (!chainSlug || !isBootstrapProbeableAddress(address)) return;
		contractProbeRequestId += 1;
		scheduleContractProbe(chainSlug, address, readImageSourceFieldInputValue(), false);
	}

	function maybeStartContractProbe(addressInput: string): void {
		cancelContractProbeTimer();
		contractProbeRequestId += 1;
		if (!isBootstrapAddressComplete(addressInput)) return;
		if (!isBootstrapProbeableAddress(addressInput)) {
			probeStatus = 'error';
			probeError = 'contract address must be 0x plus 40 hex characters';
			probeResult = null;
			probeAddress = null;
			return;
		}
		const chainSlug = chain?.slug ?? null;
		if (!chainSlug) {
			probeStatus = 'error';
			probeError = 'chain is not ready';
			return;
		}
		scheduleContractProbe(chainSlug, normalizeBootstrapAddress(addressInput), null, true);
	}

	function scheduleContractProbe(
		chainSlug: string,
		address: string,
		imageSourceFieldOverride: string | null,
		useDelay: boolean
	): void {
		const requestId = contractProbeRequestId;
		probeStatus = 'waiting';
		if (!imageSourceFieldSectionVisible) {
			probeResult = null;
			probeAddress = null;
		}
		probeError = null;
		manualEditingAllowed = false;
		resetImageCachePolicySource();
		if (!browser || !useDelay) {
			void runContractProbe(chainSlug, address, requestId, imageSourceFieldOverride);
			return;
		}
		contractProbeTimer = window.setTimeout(() => {
			void runContractProbe(chainSlug, address, requestId, imageSourceFieldOverride);
		}, contractProbeDelayMs);
	}

	async function runContractProbe(
		chainSlug: string,
		address: string,
		requestId: number,
		imageSourceFieldOverride: string | null
	): Promise<void> {
		probeStatus = 'loading';
		try {
			const result = await probeBootstrapCollectionContract(fetch, chainSlug, address, {
				imageSourceField: imageSourceFieldOverride
			});
			if (requestId !== contractProbeRequestId) return;
			probeStatus = 'ready';
			probeResult = result;
			probeAddress = result.address;
			manualEditingAllowed = false;
			applyProbeResult(result, imageSourceFieldOverride);
			if (isImageSourceFieldResolved() && openSeaEnabled) {
				scheduleOpenSeaAddressProbe(chainSlug, result.address);
			} else {
				resetOpenSeaSlugProbeState();
			}
		} catch (error) {
			if (requestId !== contractProbeRequestId) return;
			probeStatus = 'error';
			if (imageSourceFieldOverride === null) {
				probeResult = null;
				probeAddress = null;
			} else {
				probeAddress = address;
			}
			probeError = error instanceof Error ? error.message : 'contract probe failed';
		}
	}

	function scheduleOpenSeaAddressProbe(chainSlug: string, address: string): void {
		openSeaSlugProbeRequestId += 1;
		const requestId = openSeaSlugProbeRequestId;
		openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Waiting;
		openSeaSlugProbeResult = null;
		openSeaSlugProbeError = null;
		openSeaSlugProbeAddress = address;
		openSeaSlugProbeRequestedSlug = null;
		if (openSeaSlugWasAutoFilled) {
			setOpenSeaSlugInputValue('');
			lastAutoFilledOpenSeaSlug = null;
			openSeaSlugWasAutoFilled = false;
		}
		void runOpenSeaSlugProbe(chainSlug, { address }, requestId);
	}

	function onOpenSeaSlugInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		lastAutoFilledOpenSeaSlug = null;
		openSeaSlugWasAutoFilled = false;
		const slug = normalizeOpenSeaSlugInput(target.value);
		const hasValue = slug.length > 0;
		if (
			openSeaSlugProbeStatus !== openSeaSlugProbeUiStatus.Idle ||
			openSeaSlugInputHasValue !== hasValue
		) {
			openSeaSlugProbeRequestId += 1;
			resetOpenSeaSlugProbeState();
		}
		openSeaSlugInputHasValue = hasValue;
	}

	function onSubmitOpenSeaSlugProbe(event: SubmitEvent): void {
		event.preventDefault();
		if (!openSeaEnabled) return;
		const slug = readOpenSeaSlugInputValue();
		if (!slug) {
			openSeaSlugInputHasValue = false;
			return;
		}
		scheduleOpenSeaSlugVerification(slug);
	}

	function scheduleOpenSeaSlugVerification(slug: string): void {
		const chainSlug = chain?.slug ?? null;
		if (!chainSlug) return;
		openSeaSlugProbeRequestId += 1;
		const requestId = openSeaSlugProbeRequestId;
		openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Waiting;
		openSeaSlugProbeResult = null;
		openSeaSlugProbeError = null;
		openSeaSlugProbeAddress = null;
		openSeaSlugProbeRequestedSlug = slug;
		void runOpenSeaSlugProbe(chainSlug, { slug }, requestId);
	}

	async function runOpenSeaSlugProbe(
		chainSlug: string,
		input: OpenSeaSlugProbeRequest,
		requestId: number
	): Promise<void> {
		openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Loading;
		try {
			const result = await probeBootstrapOpenSeaSlug(fetch, chainSlug, input);
			if (requestId !== openSeaSlugProbeRequestId) return;
			openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Ready;
			openSeaSlugProbeResult = result;
			openSeaSlugProbeAddress = result.address;
			openSeaSlugProbeRequestedSlug = result.requestedSlug;
			applyOpenSeaSlugProbeResult(result);
		} catch (error) {
			if (requestId !== openSeaSlugProbeRequestId) return;
			openSeaSlugProbeStatus = openSeaSlugProbeUiStatus.Error;
			openSeaSlugProbeResult = null;
			openSeaSlugProbeAddress = input.address ?? null;
			openSeaSlugProbeRequestedSlug = input.slug ?? null;
			openSeaSlugProbeError = error instanceof Error ? error.message : 'OpenSea slug probe failed';
		}
	}

	function applyProbeResult(
		result: BootstrapContractProbeApiResponse,
		requestedImageSourceField: string | null
	): void {
		const patch = bootstrapProbeFormPatch(result);
		const slugSuggestion = contractNameToBootstrapSlug(result.contractName);
		const resolvedImageSourceField = normalizeFieldValue(result.firstToken.imageSourceField);
		setImageSourceFieldValue(
			resolvedImageSourceField || normalizeFieldValue(requestedImageSourceField)
		);
		imageSourceFieldDirty = false;
		if (slugSuggestion && (!bootstrapSlug.trim() || bootstrapSlug === lastAutoFilledSlug)) {
			setCollectionSlugInputValue(slugSuggestion);
			lastAutoFilledSlug = slugSuggestion;
		}
		supportsEnumerable = patch.supportsEnumerable;
		if (!patch.supportsEnumerable) {
			manualMode = patch.manualMode ?? BOOTSTRAP_ENUMERATION_MODE.ManualRange;
			manualRangeStartTokenId = patch.manualRangeStartTokenId;
			manualRangeTotalSupply = patch.manualRangeTotalSupply;
		}
		applyProbeImageCacheSuggestion(result.imageCacheSuggestion);
	}

	function applyOpenSeaSlugProbeResult(result: BootstrapOpenSeaSlugProbeApiResponse): void {
		if (result.status !== BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found || !result.slug) return;
		const resolvedSlug = normalizeOpenSeaSlugInput(result.slug);
		if (!resolvedSlug) return;
		if (result.address && result.address !== normalizedBootstrapAddress) return;
		if (result.requestedSlug && result.requestedSlug !== resolvedSlug) return;
		if (
			result.address &&
			(!bootstrapOpenSeaSlug.trim() || bootstrapOpenSeaSlug === lastAutoFilledOpenSeaSlug)
		) {
			setOpenSeaSlugInputValue(result.slug);
			lastAutoFilledOpenSeaSlug = result.slug;
			openSeaSlugWasAutoFilled = true;
			return;
		}
		if (result.requestedSlug && readOpenSeaSlugInputValue() === resolvedSlug) {
			setOpenSeaSlugInputValue(resolvedSlug);
		}
	}

	function normalizeOpenSeaSlugInput(value: string): string {
		return value.trim().toLowerCase();
	}

	function isImageSourceFieldResolved(): boolean {
		if (!latestProbeMatchesAddress || !probeResult) return false;
		const resolvedField = normalizeFieldValue(probeResult.firstToken.imageSourceField);
		if (!resolvedField || !probeResult.firstToken.image) return false;
		return normalizeFieldValue(imageSourceField) === resolvedField && !imageSourceFieldDirty;
	}

	function isOpenSeaSlugResolved(): boolean {
		if (!openSeaEnabled || openSeaSlugProbeStatus !== openSeaSlugProbeUiStatus.Ready) return false;
		if (!openSeaSlugProbeResult) return false;
		if (openSeaSlugProbeResult.status !== BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Found) return false;
		const resolvedSlug = normalizeOpenSeaSlugInput(openSeaSlugProbeResult.slug ?? '');
		if (!resolvedSlug || readOpenSeaSlugInputValue() !== resolvedSlug) return false;
		if (openSeaSlugProbeResult.address) {
			return openSeaSlugProbeResult.address === normalizedBootstrapAddress;
		}
		return openSeaSlugProbeResult.requestedSlug === resolvedSlug;
	}

	function isOpenSeaSlugIncorrect(): boolean {
		if (!openSeaEnabled || openSeaSlugProbeStatus !== openSeaSlugProbeUiStatus.Ready) return false;
		return (
			openSeaSlugProbeResult?.status === BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS.Missing &&
			openSeaSlugProbeResult.requestedSlug !== null
		);
	}

	function resolveOpenSeaBiddingUnavailableMessage(): string | null {
		if (openSeaSlugResolved) return null;
		const baseMessage =
			'OpenSea slug is not resolved, so automated bidding will not be available for this collection.';
		if (!openSeaEnabled) {
			return `${baseMessage} Set the OpenSea API key in the Admin UI config section to enable it.`;
		}
		return baseMessage;
	}

	function probeStateLabel(): string {
		if (probeStatus === 'waiting' || probeStatus === 'loading') return 'probing';
		if (probeStatus === 'ready' && probeResult) return bootstrapProbeStatusLabel(probeResult);
		if (probeStatus === 'error') return 'probe failed';
		return '';
	}

	function probeNeedsManualScope(): boolean {
		return probeStatus === 'ready' && probeResult !== null && bootstrapProbeNeedsManualScope(probeResult);
	}

	function resolveProbeStatusSectionVisible(): boolean {
		if (probeStatus === 'idle') return false;
		if (!imageSourceFieldSectionVisible || formDetailsReady) return true;
		return !imageSourceFieldDirty && !normalizeFieldValue(imageSourceField);
	}

	function probeStatusValueClass(): string {
		return probeNeedsManualScope()
			? 'bootstrap-probe-status mono bootstrap-probe-status-action-required'
			: 'bootstrap-probe-status mono';
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
			return null;
		}
		if (openSeaSlugProbeStatus === openSeaSlugProbeUiStatus.Error) {
			return openSeaSlugProbeError;
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

	function cachedTokenPreviewCard(): ApiTokenCard | null {
		const firstToken = probeResult?.firstToken;
		if (
			imageCacheMode === IMAGE_CACHE_MODE.Off ||
			!imageCacheEstimateReady ||
			!imageCacheEstimateResult?.sampleCachedImageDataUrl ||
			!firstToken?.tokenId
		) {
			return null;
		}
		return {
			tokenId: firstToken.tokenId,
			marketplaceBiddingSupported: true,
			name: firstToken.name,
			image: imageCacheEstimateResult.sampleCachedImageDataUrl,
			traitSummary: null,
			listingPrice: null,
			listingCurrency: null,
			attributes: [],
			hasMetadata: firstToken.metadataError === null,
			metadataUpdatedAt: null
		};
	}

	function applyProbeImageCacheSuggestion(
		suggestion: BootstrapContractProbeApiResponse['imageCacheSuggestion']
	): void {
		imageCachePolicySource = suggestion.selectedSource;
		imageCachePolicyExtensionKey = suggestion.extensionKey;
		imageCacheMode = suggestion.config.imageCacheMode;
		setImageCacheMaxDimensionValue(imageCacheMaxDimensionInputValue(suggestion.config.maxDimension));
		resetImageCacheEstimateState();
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
		if (
			imageCacheMode !== IMAGE_CACHE_MODE.Off &&
			!normalizeFieldValue(imageCacheMaxDimensionDraft)
		) {
			setImageCacheMaxDimensionValue(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
		}
		markImageCacheUserSelected();
		resetImageCacheEstimateState();
	}

	function onImageCacheMaxDimensionInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		imageCacheMaxDimensionDraft = target.value;
		resetImageCacheEstimateState();
		cancelImageCacheDimensionTimer();
		if (!browser) {
			commitImageCacheMaxDimensionDraft();
			return;
		}
		imageCacheDimensionTimer = window.setTimeout(
			commitImageCacheMaxDimensionDraft,
			imageCacheDimensionCommitDelayMs
		);
	}

	function onImageCacheMaxDimensionKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		void onEstimateImageCache();
	}

	function onManualScopeModeChange(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLSelectElement)) return;
		manualMode =
			target.value === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
				? BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
				: BOOTSTRAP_ENUMERATION_MODE.ManualRange;
		resetImageCacheEstimateState();
	}

	function onManualTokenIdsInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLTextAreaElement)) return;
		manualTokenIds = target.value;
		resetImageCacheEstimateState();
	}

	function onManualRangeStartTokenIdInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		manualRangeStartTokenId = target.value;
		resetImageCacheEstimateState();
	}

	function onManualRangeTotalSupplyInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		manualRangeTotalSupply = target.value;
		resetImageCacheEstimateState();
	}

	function commitImageCacheMaxDimensionDraft(): void {
		cancelImageCacheDimensionTimer();
		imageCacheMaxDimension = imageCacheMaxDimensionDraft;
		markImageCacheUserSelected();
	}

	function canRunImageCacheEstimate(): boolean {
		if (!formDetailsReady || imageCacheMode === IMAGE_CACHE_MODE.Off) return false;
		if (!probeResult?.firstToken.tokenId || !probeResult.firstToken.image) return false;
		if (!resolvedBootstrapScopeTotalSupply()) return false;
		return imageCacheEstimateStatus === imageCacheEstimateUiStatus.Idle;
	}

	async function onEstimateImageCache(): Promise<void> {
		if (!chain || !probeResult || !canRunImageCacheEstimate()) return;
		commitImageCacheMaxDimensionDraft();
		let maxDimension: number | null;
		try {
			maxDimension = parseImageCacheMaxDimension();
		} catch (error) {
			imageCacheEstimateStatus = imageCacheEstimateUiStatus.Error;
			imageCacheEstimateResult = null;
			imageCacheEstimateError =
				error instanceof Error ? error.message : 'invalid image cache setting';
			return;
		}
		const firstToken = probeResult.firstToken;
		const totalSupply = resolvedBootstrapScopeTotalSupply();
		if (!firstToken.tokenId || !firstToken.image || !totalSupply) return;
		imageCacheEstimateRequestId += 1;
		const requestId = imageCacheEstimateRequestId;
		imageCacheEstimateStatus = imageCacheEstimateUiStatus.Loading;
		imageCacheEstimateResult = null;
		imageCacheEstimateError = null;
		try {
			const result = await estimateBootstrapImageCache(fetch, chain.slug, {
				sampleTokenId: firstToken.tokenId,
				sourceImageUrl: firstToken.image,
				sourceImageBytes: firstToken.imageBytes,
				totalSupply,
				imageCacheMode,
				maxDimension
			});
			if (requestId !== imageCacheEstimateRequestId) return;
			imageCacheEstimateStatus = imageCacheEstimateUiStatus.Ready;
			imageCacheEstimateResult = result;
			imageCacheEstimateError = null;
		} catch (error) {
			if (requestId !== imageCacheEstimateRequestId) return;
			imageCacheEstimateStatus = imageCacheEstimateUiStatus.Error;
			imageCacheEstimateResult = null;
			imageCacheEstimateError =
				error instanceof Error ? error.message : 'image cache estimate failed';
		}
	}

	function manualTokenIdList(): string[] {
		return manualTokenIds
			.split(/[\s,]+/)
			.map((value) => value.trim())
			.filter(Boolean);
	}

	function normalizedManualRangeStartTokenId(): string {
		return normalizeFieldValue(manualRangeStartTokenId);
	}

	function normalizedManualRangeTotalSupply(): string {
		const value = normalizeFieldValue(manualRangeTotalSupply);
		return /^\d+$/.test(value) && BigInt(value) > 0n ? value : '';
	}

	function resolvedBootstrapScopeTotalSupply(): string | null {
		if (!formDetailsReady || !probeResult) return null;
		if (supportsEnumerable) {
			return probeResult.totalSupply.value ?? null;
		}
		if (manualMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds) {
			const tokenIds = manualTokenIdList();
			return tokenIds.length > 0 ? String(tokenIds.length) : null;
		}
		return normalizedManualRangeTotalSupply() || null;
	}

	function manualScopeBlocker(): string | null {
		if (!formDetailsReady || supportsEnumerable) return null;
		if (manualMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds) {
			return manualTokenIdList().length === 0
				? 'Manual token IDs are required before queueing bootstrap.'
				: null;
		}

		const startTokenId = normalizedManualRangeStartTokenId();
		if (!startTokenId) {
			return 'Manual range start token ID is required before queueing bootstrap.';
		}
		const totalSupply = normalizedManualRangeTotalSupply();
		if (!totalSupply) {
			return 'Manual range total supply must be a positive integer.';
		}

		const inferred = probeResult?.suggestedInput.manualInput;
		if (
			inferred &&
			(inferred.startTokenId !== startTokenId || String(inferred.totalSupply) !== totalSupply)
		) {
			return 'Manual scope must match the latest contract probe.';
		}
		return null;
	}

	function imageCacheEstimateBlocker(): string | null {
		if (imageCacheMode === IMAGE_CACHE_MODE.Off || imageCacheEstimateReady) return null;
		if (imageCacheEstimateFailed) {
			return 'Image cache estimate must succeed before queueing bootstrap.';
		}
		if (!probeResult?.firstToken.tokenId || !probeResult.firstToken.image) {
			return 'Token image source must resolve before estimating image cache.';
		}
		if (!resolvedBootstrapScopeTotalSupply()) {
			return 'Set collection scope and supply before estimating image cache.';
		}
		return 'Run image cache estimate before queueing bootstrap.';
	}

	function resolveQueueBootstrapBlockers(): string[] {
		const blockers: string[] = [];
		if (!chain) blockers.push('Chain configuration is still loading.');
		if (!addressCanBeProbed) blockers.push('Enter a valid contract address.');
		if (!formDetailsReady) blockers.push('Contract probe must finish before queueing bootstrap.');
		if (!collectionSlugInputHasValue) blockers.push('Collection slug is required.');
		if (openSeaSlugProbePending) blockers.push('OpenSea slug resolution is still running.');
		if (openSeaEnabled && openSeaSlugInputHasValue && !openSeaSlugResolved) {
			blockers.push('OpenSea slug must resolve before queueing bootstrap.');
		}
		const scopeBlocker = manualScopeBlocker();
		if (scopeBlocker) blockers.push(scopeBlocker);
		const cacheBlocker = imageCacheEstimateBlocker();
		if (cacheBlocker) blockers.push(cacheBlocker);
		return blockers;
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
		return `${imageCacheModeLabel(IMAGE_CACHE_MODE.RefreshOnMetadata)}; max ${imageCacheDimensionPlanLabel()}`;
	}

	function imageCacheSampleOutputValue(): string {
		if (imageCacheMode === IMAGE_CACHE_MODE.Off) return 'not cached';
		if (!imageCacheEstimateReady || !imageCacheEstimateResult) return 'not estimated';
		return formatByteSize(imageCacheEstimateResult.sampleCachedBytes);
	}

	function originalImageDimensionsValue(): string {
		if (!probeResult?.firstToken.image) return 'not available';
		const { imageWidth, imageHeight } = probeResult.firstToken;
		if (!imageWidth || !imageHeight) return 'unknown';
		return `${imageWidth} x ${imageHeight}px`;
	}

	function projectedTokenUriPayloadSizeValue(): string {
		const projectedBytes = probeResult?.storageEstimate?.projectedBytes;
		if (projectedBytes) return formatByteSize(projectedBytes);
		const sampleBytes = probeResult?.firstToken.tokenUriPayloadBytes;
		return projectedByteSizeValue(sampleBytes);
	}

	function projectedOriginalImageSizeValue(): string {
		const projectedBytes = probeResult?.imageStorageEstimate?.projectedBytes;
		if (projectedBytes) return formatByteSize(projectedBytes);
		const sampleBytes = probeResult?.firstToken.imageBytes;
		return projectedByteSizeValue(sampleBytes);
	}

	function projectedByteSizeValue(sampleBytes: number | null | undefined): string {
		if (sampleBytes === null || sampleBytes === undefined) return '-';
		const totalSupply = resolvedBootstrapScopeTotalSupply();
		if (!totalSupply) return '-';
		return formatByteSize((BigInt(sampleBytes) * BigInt(totalSupply)).toString());
	}

	function imageCacheOutputDimensionsValue(): string {
		if (imageCacheMode === IMAGE_CACHE_MODE.Off) return 'not cached';
		if (!imageCacheEstimateReady || !imageCacheEstimateResult) return 'not estimated';
		const { width, height } = imageCacheEstimateResult;
		if (!width || !height) return 'unknown';
		return `${width} x ${height}px`;
	}

	function imageCacheProjectedOutputValue(): string {
		if (imageCacheMode === IMAGE_CACHE_MODE.Off) return 'not cached';
		if (!imageCacheEstimateReady || !imageCacheEstimateResult) return 'not estimated';
		return formatByteSize(imageCacheEstimateResult.projectedCachedBytes);
	}

	function probeSubmitGuard(address: string): string | null {
		if (!isBootstrapProbeableAddress(address)) return 'valid address is required';
		if (!latestProbeMatchesAddress) return 'contract probe must complete before queueing bootstrap';
		if (!imageSourceFieldResolved) return 'image source field must resolve before queueing bootstrap';
		if (supportsEnumerable && probeResult?.enumerable.supported !== true) {
			return 'enumerable support was not confirmed';
		}
		const scopeBlocker = manualScopeBlocker();
		if (scopeBlocker) return scopeBlocker;
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

	function onBootstrapFormSubmit(event: SubmitEvent): void {
		event.preventDefault();
	}

	async function onSubmitBootstrap(): Promise<void> {
		submitError = null;
		if (!chain) {
			submitError = 'chain is not ready';
			return;
		}

		const slug = readCollectionSlugInputValue();
		const address = normalizeFieldValue(bootstrapAddress).toLowerCase();
		const openseaSlug = openSeaEnabled ? readOpenSeaSlugInputValue() : '';
		if (!slug || !address) {
			submitError = 'slug and address are required';
			return;
		}
		if (openSeaEnabled && openseaSlug && !openSeaSlugResolved) {
			submitError = 'OpenSea slug must resolve before queueing bootstrap';
			return;
		}
		const probeGuardError = probeSubmitGuard(address);
		if (probeGuardError) {
			submitError = probeGuardError;
			return;
		}
		const resolvedImageSourceField = normalizeFieldValue(
			probeResult?.firstToken.imageSourceField
		);
		if (!resolvedImageSourceField) {
			submitError = 'image source field is required';
			return;
		}

		let manualInput:
			| {
					mode: typeof BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds;
					tokenIds: string[];
			  }
			| {
					mode: typeof BOOTSTRAP_ENUMERATION_MODE.ManualRange;
					startTokenId: string;
					totalSupply: number;
			  }
			| undefined;

		if (!supportsEnumerable) {
			if (manualMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds) {
				const tokenIds = manualTokenIdList();
				if (tokenIds.length === 0) {
					submitError = 'token ids are required';
					return;
				}
				manualInput = {
					mode: BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
					tokenIds
				};
			} else {
				const startTokenId = normalizedManualRangeStartTokenId();
				const totalSupply = Number(normalizedManualRangeTotalSupply());
				if (!startTokenId) {
					submitError = 'start token id is required';
					return;
				}
				if (!Number.isInteger(totalSupply) || totalSupply <= 0) {
					submitError = 'total supply must be a positive integer';
					return;
				}
				manualInput = {
					mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
					startTokenId,
					totalSupply
				};
			}
		}

		let imageCacheMaxDimensionValue: number | null = null;
		if (imageCacheMode !== IMAGE_CACHE_MODE.Off) {
			commitImageCacheMaxDimensionDraft();
			try {
				imageCacheMaxDimensionValue = parseImageCacheMaxDimension();
			} catch (error) {
				submitError = error instanceof Error ? error.message : 'invalid image cache setting';
				return;
			}
			if (!imageCacheEstimateReady) {
				submitError = 'Run image cache estimate before queueing bootstrap';
				return;
			}
		}

		submitting = true;
		try {
			const result = await createBootstrapRun(fetch, chain.slug, {
				slug,
				address,
				openseaSlug: openseaSlug || undefined,
				imageSourceField: resolvedImageSourceField,
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

{#snippet inProgressStatus(label: string, ariaLabel: string)}
	<span class="bootstrap-inline-progress">
		<span>{label}</span>
		<LoadingBladeBar {ariaLabel} barLength={2} />
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

	<form
		id={openSeaSlugProbeFormId}
		class="bootstrap-hidden-form"
		onsubmit={onSubmitOpenSeaSlugProbe}
	></form>
	<form
		id={imageSourceProbeFormId}
		class="bootstrap-hidden-form"
		onsubmit={onSubmitImageSourceProbe}
	></form>
	<form class="bootstrap-form bootstrap-create-form" onsubmit={onBootstrapFormSubmit}>
		<div class="bootstrap-create-layout">
			<div class="bootstrap-form-fields">
				{#if submitError}
					<div class="bootstrap-form-feedback">
						<span class="muted">{submitError}</span>
					</div>
				{/if}

				<div class="bootstrap-form-section bootstrap-address-section">
					<label class="bootstrap-form-row">
						{@render fieldLabel('Contract address', bootstrapFieldHelp.address)}
						<input
							value={bootstrapAddress}
							class={`${bootstrapInputClass} bootstrap-input-address`}
							type="text"
							name="address"
							required
							oninput={onBootstrapAddressInput}
							onfocus={onBootstrapAddressFocus}
						/>
					</label>
				</div>

				{#if imageSourceFieldSectionVisible}
					<div class="bootstrap-form-section bootstrap-image-source-section">
						<label class="bootstrap-form-row">
							{@render fieldLabel('Image source field', bootstrapFieldHelp.imageSourceField)}
							<div class="bootstrap-input-status-row">
								<input
									bind:this={imageSourceFieldInputElement}
									value={imageSourceField}
									class={`${bootstrapInputClass} bootstrap-input-slug`}
									type="text"
									name="imageSourceField"
									form={imageSourceProbeFormId}
									oninput={onImageSourceFieldInput}
								/>
								{#if imageSourceFieldResolved}
									<span class="bid-book-own-status bid-book-own-status-draw bootstrap-resolution-badge">
										resolved
									</span>
								{:else if contractProbePending}
									<span class="muted">
										{@render inProgressStatus('probing', 'probing image source field')}
									</span>
								{:else if imageSourceProbeButtonVisible}
									<button
										type="submit"
										form={imageSourceProbeFormId}
										disabled={!addressCanBeProbed}
									>
										probe again
									</button>
								{/if}
							</div>
						</label>
						{#if probeError}
							<div class="bootstrap-form-row">
								{@render fieldLabel('Probe error', bootstrapFieldHelp.probeError)}
								<div class="muted">{probeError}</div>
							</div>
						{/if}
					</div>
				{/if}

				{#if formDetailsReady && firstTokenCard}
					<div class="bootstrap-form-section bootstrap-token-preview-section">
						<aside class="bootstrap-token-card-pane" aria-label="Token image preview">
							<div class="bootstrap-probe-token-card" data-testid={TEST_IDS.BootstrapProbeTokenCard}>
								<TokenCardTile
									{chain}
									collection={null}
									token={firstTokenCard}
									href="#"
									selectedMediaMode={COLLECTION_MEDIA_MODES.Snapshot}
									availableMediaModes={bootstrapPreviewMediaModes}
									{tokenPreview}
									showMeta={false}
								/>
							</div>
						</aside>
					</div>
				{/if}

				{#if probeStatusSectionVisible}
					<div class="bootstrap-form-section bootstrap-probe-section">
						<div class="bootstrap-form-row">
							{@render fieldLabel('Contract probe status', bootstrapFieldHelp.probeStatus)}
							<div class={probeStatusValueClass()}>
								{#if probeStatus === 'waiting' || probeStatus === 'loading'}
									{@render inProgressStatus('probing', 'probing contract')}
								{:else}
									<span>{probeStateLabel()}</span>
									{#if probeNeedsManualScope()}
										<InfoTooltip
											text={manualScopeProbeMessage}
											tone="warning"
											className="bootstrap-probe-status-tooltip"
										/>
									{/if}
								{/if}
							</div>
						</div>
						{#if probeError}
							<div class="bootstrap-form-row">
								{@render fieldLabel('Probe error', bootstrapFieldHelp.probeError)}
								<div class="muted">{probeError}</div>
							</div>
						{/if}
						{#if formDetailsReady && probeResult}
							<div class="bootstrap-probe-chip-grid">
								<div class="bootstrap-probe-chip">
									<div class="bootstrap-probe-chip-title mono">standard / interfaces / supply</div>
									<div class="bootstrap-probe-chip-body">
										<div class="bootstrap-form-row">
											{@render fieldLabel('Standard', bootstrapFieldHelp.standard)}
											<div class="mono">{probeResult.standard}</div>
										</div>
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
									</div>
								</div>
								<div class="bootstrap-probe-chip">
									<div class="bootstrap-probe-chip-title mono">sample token & metadata</div>
									<div class="bootstrap-probe-chip-body">
										<div class="bootstrap-form-row">
											{@render fieldLabel('Sample token ID', bootstrapFieldHelp.firstTokenId)}
											<div class="mono">{probeResult.firstToken.tokenId ?? '-'}</div>
										</div>
										<div class="bootstrap-form-row">
											{@render fieldLabel('Sample token source', bootstrapFieldHelp.firstTokenSource)}
											<div class="mono">{probeResult.firstToken.source ?? '-'}</div>
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
												{projectedTokenUriPayloadSizeValue()}
											</div>
										</div>
									</div>
								</div>
							</div>
						{/if}
						{#if probeResult && probeResult.suggestedInput.warnings.length > 0}
							<div class="bootstrap-form-row bootstrap-probe-warning-row">
								{@render fieldLabel('Probe warnings', bootstrapFieldHelp.probeWarnings)}
								<div class="bootstrap-probe-warnings">
									{#each probeResult.suggestedInput.warnings as warning}
										<span class="muted">{warning}</span>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				{/if}

				{#if formDetailsReady}
					<div class="bootstrap-form-section">
						<label class="bootstrap-form-row">
							{@render fieldLabel('Collection slug', bootstrapFieldHelp.slug)}
							<input
								bind:this={collectionSlugInputElement}
								value={bootstrapSlug}
								class={`${bootstrapInputClass} bootstrap-input-slug`}
								type="text"
								name="slug"
								required
								oninput={onCollectionSlugInput}
							/>
						</label>
						<label class="bootstrap-form-row">
							{@render fieldLabel('OpenSea slug', bootstrapFieldHelp.openseaSlug)}
							<div class="bootstrap-input-with-note">
								<div class="bootstrap-input-status-row">
									<input
										bind:this={openSeaSlugInputElement}
										value={bootstrapOpenSeaSlug}
										class={`${bootstrapInputClass} bootstrap-input-slug`}
										type="text"
										name="openseaSlug"
										form={openSeaSlugProbeFormId}
										disabled={!openSeaEnabled}
										oninput={onOpenSeaSlugInput}
									/>
									{#if openSeaSlugResolved}
										<span class="bid-book-own-status bid-book-own-status-draw bootstrap-resolution-badge">
											resolved
										</span>
									{:else if openSeaSlugIncorrect}
										<span class="bid-book-own-status bid-book-own-status-cancelled bootstrap-resolution-badge">
											incorrect
										</span>
									{:else if openSeaSlugProbePending}
										<span class="muted">
											{@render inProgressStatus('resolving', 'resolving OpenSea slug')}
										</span>
									{:else}
										<button
											type="submit"
											form={openSeaSlugProbeFormId}
											disabled={!openSeaEnabled || !openSeaSlugInputHasValue}
										>
											resolve
										</button>
									{/if}
								</div>
								{#if openSeaSlugProbeMessage()}
									<span class="muted bootstrap-opensea-slug-note">{openSeaSlugProbeMessage()}</span>
								{/if}
							</div>
						</label>
					</div>

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

					{#if !supportsEnumerable}
						<div class="bootstrap-form-section">
							<label class="bootstrap-form-row">
								{@render fieldLabel('Manual token scope mode', bootstrapFieldHelp.manualMode)}
								<select
									value={manualMode}
									class={`${bootstrapSelectClass} bootstrap-input-select-medium`}
									onchange={onManualScopeModeChange}
									disabled={probeControlledDisabled}
								>
									<option value={BOOTSTRAP_ENUMERATION_MODE.ManualRange}>start + total supply</option>
									<option value={BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds}>token ids list</option>
								</select>
							</label>
							{#if manualMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds}
								<label class="bootstrap-form-row bootstrap-form-row-textarea">
									{@render fieldLabel('Manual token IDs', bootstrapFieldHelp.tokenIds)}
									<textarea
										value={manualTokenIds}
										class={`${bootstrapTextareaClass} bootstrap-input-token-ids`}
										rows="4"
										oninput={onManualTokenIdsInput}
										disabled={probeControlledDisabled}
									></textarea>
								</label>
							{:else}
								<label class="bootstrap-form-row">
									{@render fieldLabel('Manual range start token ID', bootstrapFieldHelp.startTokenId)}
									<input
										value={manualRangeStartTokenId}
										class={`${bootstrapInputClass} bootstrap-input-token-id`}
										type="text"
										oninput={onManualRangeStartTokenIdInput}
										disabled={probeControlledDisabled}
									/>
								</label>
								<label class="bootstrap-form-row">
									{@render fieldLabel('Manual range total supply', bootstrapFieldHelp.manualRangeTotalSupply)}
									<input
										value={manualRangeTotalSupply}
										class={`${bootstrapInputClass} bootstrap-input-total-supply`}
										type="text"
										inputmode="numeric"
										pattern="[0-9]*"
										oninput={onManualRangeTotalSupplyInput}
										disabled={probeControlledDisabled}
									/>
								</label>
							{/if}
						</div>
					{/if}

					<div class="bootstrap-form-section">
						<label class="bootstrap-form-row">
							{@render fieldLabel('Image cache mode', bootstrapFieldHelp.imageCacheMode)}
							<select
								value={imageCacheMode}
								class={`${bootstrapSelectClass} bootstrap-input-select-medium`}
								onchange={onImageCacheModeChange}
								disabled={imageCacheExtensionControlledDisabled}
							>
								<option value={IMAGE_CACHE_MODE.Off}>
									{imageCacheModeLabel(IMAGE_CACHE_MODE.Off)}
								</option>
								<option value={IMAGE_CACHE_MODE.CacheOnce}>
									{imageCacheModeLabel(IMAGE_CACHE_MODE.CacheOnce)}
								</option>
								<option value={IMAGE_CACHE_MODE.RefreshOnMetadata}>
									{imageCacheModeLabel(IMAGE_CACHE_MODE.RefreshOnMetadata)}
								</option>
							</select>
						</label>
						{#if imageCacheMode !== IMAGE_CACHE_MODE.Off}
							<label class="bootstrap-form-row">
								{@render fieldLabel('Cached image max dimension', bootstrapFieldHelp.imageMaxDimension)}
								<div class="bootstrap-input-status-row">
									<input
										value={imageCacheMaxDimensionDraft}
										class={`${bootstrapInputClass} bootstrap-input-total-supply`}
										type="text"
										inputmode="numeric"
										pattern="[0-9]*"
										oninput={onImageCacheMaxDimensionInput}
										onkeydown={onImageCacheMaxDimensionKeydown}
										disabled={imageCacheExtensionControlledDisabled}
									/>
									{#if imageCacheEstimateReady}
										<span class="bid-book-own-status bid-book-own-status-draw bootstrap-resolution-badge">
											estimated
										</span>
									{:else if imageCacheEstimateFailed}
										<span class="bid-book-own-status bid-book-own-status-cancelled bootstrap-resolution-badge">
											failed
										</span>
									{:else if imageCacheEstimatePending}
										<span class="muted">
											{@render inProgressStatus('estimating', 'estimating image cache size')}
										</span>
									{:else}
										<button
											type="button"
											disabled={!imageCacheEstimateCanRun}
											onclick={() => void onEstimateImageCache()}
										>
											estimate
										</button>
									{/if}
								</div>
							</label>
						{/if}
						{#if imageCacheEstimateError}
							<div class="bootstrap-form-row">
								{@render fieldLabel('Image cache estimate', bootstrapFieldHelp.imageCacheEstimate)}
								<span class="muted">{imageCacheEstimateError}</span>
							</div>
						{/if}
						{#if probeResult}
							<div class="bootstrap-probe-chip bootstrap-image-estimate-chip">
								<div class="bootstrap-probe-chip-title mono">image data and storage estimates</div>
								<div class="bootstrap-probe-chip-body">
									<div class="bootstrap-form-row">
										{@render fieldLabel('Original image source size (1 token)', bootstrapFieldHelp.originalImageFileSize)}
										<div class="mono">
											{formatByteSize(probeResult.firstToken.imageBytes)}
										</div>
									</div>
									<div class="bootstrap-form-row">
										{@render fieldLabel('Original image dimensions', bootstrapFieldHelp.originalImageDimensions)}
										<div class="mono bootstrap-estimate-highlight">
											{originalImageDimensionsValue()}
										</div>
									</div>
									<div class="bootstrap-form-row">
										{@render fieldLabel('Est. source images size (full collection)', bootstrapFieldHelp.projectedOriginalImageFileSize)}
										<div class="mono bootstrap-estimate-highlight">
											{projectedOriginalImageSizeValue()}
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
										{@render fieldLabel('Cached image size (1 token)', bootstrapFieldHelp.imageCacheSampleOutputSize)}
										<div class="mono">{imageCacheSampleOutputValue()}</div>
									</div>
									<div class="bootstrap-form-row">
										{@render fieldLabel('Cached image dimensions', bootstrapFieldHelp.imageCacheSampleOutputDimensions)}
										<div class="mono bootstrap-estimate-highlight">
											{imageCacheOutputDimensionsValue()}
										</div>
									</div>
									<div class="bootstrap-form-row">
										{@render fieldLabel('Est. cached images size (full collection)', bootstrapFieldHelp.projectedImageCacheOutputSize)}
										<div class="mono bootstrap-estimate-highlight">
											{imageCacheProjectedOutputValue()}
										</div>
									</div>
								</div>
							</div>
						{/if}
						{#if cachedTokenCard}
							<div class="bootstrap-cache-preview-block">
								<span class="muted">{imageCachePreviewMessage}</span>
								<aside class="bootstrap-token-card-pane" aria-label="Cached token image preview">
									<div
										class="bootstrap-probe-token-card"
										data-testid={TEST_IDS.BootstrapCacheTokenCard}
									>
										<TokenCardTile
											{chain}
											collection={null}
											token={cachedTokenCard}
											href="#"
											selectedMediaMode={COLLECTION_MEDIA_MODES.Snapshot}
											availableMediaModes={bootstrapPreviewMediaModes}
											{tokenPreview}
											showMeta={false}
										/>
									</div>
								</aside>
							</div>
						{/if}
					</div>

					<div class="bootstrap-form-actions">
						{#each queueBootstrapBlockers as blocker}
							<span class="muted">{blocker}</span>
						{/each}
						{#if openSeaBiddingUnavailableMessage}
							<span class="muted">{openSeaBiddingUnavailableMessage}</span>
						{/if}
						<button type="button" disabled={submitDisabled} onclick={() => void onSubmitBootstrap()}>
							{submitting ? 'submitting...' : 'queue bootstrap'}
						</button>
					</div>
					{/if}
				</div>
			</div>
		</form>

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th>run</th>
					<th>collection</th>
					<th>status</th>
					<th>enumeration</th>
					<th>progress</th>
					<th>updated</th>
				</tr>
			</thead>
			<tbody>
				{#if page.items.length === 0}
					<tr>
						<td colspan="6" class="empty-cell">no bootstrap runs found</td>
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
