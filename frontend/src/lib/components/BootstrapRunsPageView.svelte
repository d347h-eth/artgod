<script lang="ts">
	import { goto } from '$app/navigation';
	import { onDestroy, tick } from 'svelte';
	import {
		BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MAX_DIMENSION,
		BOOTSTRAP_IMAGE_CACHE_MIN_DIMENSION
	} from '@artgod/shared/config/bootstrap';
	import { OPENSEA_API_KEY_ENV } from '@artgod/shared/config/opensea-integration';
	import { IMAGE_CACHE_MODE, imageCacheModeLabel } from '@artgod/shared/media/token-image-cache';
	import { COLLECTION_MEDIA_MODE_OPTIONS, COLLECTION_MEDIA_MODES } from '@artgod/shared/extensions';
	import { COLLECTION_CUSTOMIZATION_SOURCE_KIND } from '@artgod/shared/types';
	import type {
		ApiChain,
		ApiCollectionMediaMode,
		ApiImageCacheMode,
		ApiOpenSeaIntegrationStatus,
		ApiTokenCard,
		BootstrapContractProbeApiResponse,
		BootstrapImageCacheEstimateApiResponse,
		BootstrapRunsApiResponse
	} from '$lib/api-types';
	import {
		createBootstrapRun,
		BackendApiError,
		estimateBootstrapImageCache,
		probeBootstrapCollectionContract
	} from '$lib/backend-api';
	import {
		BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_ACKNOWLEDGEMENT,
		BOOTSTRAP_PROBE_UI_STATUS,
		BOOTSTRAP_MANUAL_RANGE_DEFAULT_START_TOKEN_ID,
		BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_WARNING,
		bootstrapSampleOwnership,
		bootstrapSampleFailure,
		contractNameToBootstrapSlug,
		formatByteSize,
		isBootstrapProbeableAddress,
		normalizeBootstrapAddress
	} from '$lib/bootstrap-contract-probe';
	import { DEFAULT_BOOTSTRAP_METADATA_MODE } from '$lib/bootstrap-metadata-mode';
	import {
		bootstrapSetupIssues,
		bootstrapSampleMatchesScope,
		bootstrapTokenIds,
		type BootstrapSetupDraft
	} from '$lib/bootstrap-setup';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import InfoTooltip from '$lib/components/InfoTooltip.svelte';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
	import OpenSeaSlugResolverControl from '$lib/components/OpenSeaSlugResolverControl.svelte';
	import TokenCardTile from '$lib/components/TokenCardTile.svelte';
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import WarningIcon from '$lib/components/WarningIcon.svelte';
	import JsonPayloadPreview from '$lib/components/JsonPayloadPreview.svelte';
	import type { OpenSeaSlugResolverState } from '$lib/components/open-sea-slug-resolver-state';
	import { getTokenPreviewController } from '$lib/components/token-preview-controller';
	import {
		resolveTokenMediaIframeSource,
		tokenMediaTitle,
		type TokenMediaIframeSource
	} from '$lib/token-media';
	import { APP_VERSION } from '$lib/runtime/app-version';
	import { TEST_IDS } from '$lib/test-ids';
	import { BOOTSTRAP_ENUMERATION_MODE } from '@artgod/shared/bootstrap/pipeline';

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
	const imageCacheEstimateUiStatus = {
		Idle: 'idle',
		Loading: 'loading',
		Ready: 'ready',
		Error: 'error'
	} as const;
	type ImageCacheEstimateUiStatus =
		(typeof imageCacheEstimateUiStatus)[keyof typeof imageCacheEstimateUiStatus];
	const BOOTSTRAP_PREVIEW_SOURCE = {
		Image: 'image',
		Animation: 'animation'
	} as const;
	type BootstrapPreviewSource =
		(typeof BOOTSTRAP_PREVIEW_SOURCE)[keyof typeof BOOTSTRAP_PREVIEW_SOURCE];
	const openSeaSetupMessage = `Set ${OPENSEA_API_KEY_ENV} in Admin UI to sync OpenSea market/orderbook asks/offers required by built-in bidding bot features. Fully restart the app after saving the key in Admin UI.`;
	const imageCachePreviewMessage =
		'This preview was generated with the selected cache settings. If it looks wrong or does not render, choose caching: off.';
	const bootstrapPreviewMediaModes: ApiCollectionMediaMode[] = [
		COLLECTION_MEDIA_MODE_OPTIONS.Snapshot
	];
	const tokenPreview = getTokenPreviewController();
	const bootstrapFieldHelp = {
		address: 'ERC721 contract address to bootstrap on the selected chain.',
		imageSourceField:
			'Required metadata property used for token images, for example image or image_url.',
		animationSourceField:
			'Optional metadata property used for animation, for example animation_url. Leave blank to skip animation.',
		sampleTokenId:
			'One existing token for optional metadata checks, previews, estimates and OpenSea lookup. It does not define the collection scope.',
		slug: 'Required local collection slug used in ArtGod URLs.',
		openseaSlug:
			'Optional for bootstrap. OpenSea sync and bidding require a resolved collection slug.',
		erc721Interface: 'Whether the contract reports ERC721 support.',
		enumerableInterface: 'Whether the contract reports ERC721Enumerable support.',
		contractTotalSupply:
			'The contract totalSupply() value. This may cover several projects or only minted tokens.',
		imageCacheMode: 'Whether to store token images locally, and when to refresh them.',
		imageMaxDimension:
			'Maximum cached image width or height in pixels. Leave blank to keep original dimensions.',
		manualMode:
			'Choose this collection’s token range or explicit token IDs. Entire contract includes every project on the contract.',
		tokenIds: 'Required explicit token IDs, separated by commas or whitespace.',
		startTokenId: 'First token ID in the declared range, including IDs that are not yet minted.',
		manualRangeTotalSupply:
			'Number of IDs in the range, including unminted IDs. Last ID = first ID + token count - 1.'
	} as const;

	let bootstrapSlug = $state('');
	let collectionSlugInputElement = $state<HTMLInputElement | null>(null);
	let bootstrapAddress = $state('');
	let contractAddressSafetyAcknowledged = $state(false);
	let imageSourceField = $state('');
	let imageSourceFieldInputElement = $state<HTMLInputElement | null>(null);
	let imageSourceFieldDirty = $state(false);
	let animationSourceField = $state('');
	let animationSourceFieldInputElement = $state<HTMLInputElement | null>(null);
	let animationSourceFieldInputHasValue = $state(false);
	let animationSourceFieldDirty = $state(false);
	let sampleTokenId = $state('');
	let sampleTokenIdInputElement = $state<HTMLInputElement | null>(null);
	let sampleTokenIdInputHasValue = $state(false);
	let sampleTokenIdDirty = $state(false);
	let selectedBootstrapPreviewSource = $state<BootstrapPreviewSource>(BOOTSTRAP_PREVIEW_SOURCE.Image);
	let bootstrapOpenSeaSlug = $state('');
	let openSeaSlugResolved = $state(false);
	let supportsEnumerable = $state(false);
	let manualMode = $state<BootstrapManualEnumerationMode>(BOOTSTRAP_ENUMERATION_MODE.ManualRange);
	let manualTokenIds = $state('');
	let manualRangeStartTokenId = $state(BOOTSTRAP_MANUAL_RANGE_DEFAULT_START_TOKEN_ID);
	let manualRangeTotalSupply = $state('');
	let imageCacheMode = $state<ApiImageCacheMode>(IMAGE_CACHE_MODE.CacheOnce);
	let imageCacheMaxDimensionDraft = $state(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let probeStatus = $state<
		(typeof BOOTSTRAP_PROBE_UI_STATUS)[keyof typeof BOOTSTRAP_PROBE_UI_STATUS]
	>(BOOTSTRAP_PROBE_UI_STATUS.Idle);
	let probeResult = $state<BootstrapContractProbeApiResponse | null>(null);
	let probeError = $state<string | null>(null);
	let probeAddress = $state<string | null>(null);
	let imageCacheEstimateStatus = $state<ImageCacheEstimateUiStatus>(imageCacheEstimateUiStatus.Idle);
	let imageCacheEstimateResult = $state<BootstrapImageCacheEstimateApiResponse | null>(null);
	let imageCacheEstimateError = $state<string | null>(null);
	let openSeaSlugResolver: OpenSeaSlugResolverControl | undefined = $state();
	let contractProbeRequestId = 0;
	let probeInputsChanged = $state(false);
	let probeDetailsOpen = $state(false);
	let samplePreviewOpen = $state(false);
	let cachePreviewOpen = $state(false);
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
		probeStatus === BOOTSTRAP_PROBE_UI_STATUS.Ready && probeAddress === normalizedBootstrapAddress
	);
	let contractProbePending = $derived(probeStatus === BOOTSTRAP_PROBE_UI_STATUS.Loading);
	let imageSourceFieldResolved = $derived(isImageSourceFieldResolved());
	let sourceFieldsReady = $derived(
		latestProbeMatchesAddress && probeResult !== null && imageSourceFieldResolved
	);
	let animationSourceFieldResolved = $derived(isAnimationSourceFieldResolved());
	let animationSourceFieldIncorrect = $derived(isAnimationSourceFieldIncorrect());
	let sampleTokenIdResolved = $derived(isSampleTokenIdResolved());
	let sampleTokenIdIncorrect = $derived(isSampleTokenIdIncorrect());
	let sampleProbeFailure = $derived(
		latestProbeMatchesAddress && probeResult ? bootstrapSampleFailure(probeResult) : null
	);
	let formDetailsReady = $derived(sourceFieldsReady && sampleTokenIdResolved && !sampleProbeFailure);
	let imageCacheEstimatePending = $derived(
		imageCacheEstimateStatus === imageCacheEstimateUiStatus.Loading
	);
	let imageCacheEstimateReady = $derived(
		imageCacheEstimateStatus === imageCacheEstimateUiStatus.Ready && imageCacheEstimateResult !== null
	);
	let imageCacheEstimateFailed = $derived(
		imageCacheEstimateStatus === imageCacheEstimateUiStatus.Error
	);
	let imageCacheEstimateCanRun = $derived(canRunImageCacheEstimate());
	let setupDraft: BootstrapSetupDraft = $derived({
		address: bootstrapAddress,
		slug: bootstrapSlug,
		imageSourceField,
		scopeMode: supportsEnumerable ? BOOTSTRAP_ENUMERATION_MODE.Enumerable : manualMode,
		startTokenId: manualRangeStartTokenId,
		totalSupply: manualRangeTotalSupply,
		tokenIds: manualTokenIds,
		imageCacheMode,
		maxDimension: imageCacheMaxDimensionDraft
	});
	let setupIssues = $derived(bootstrapSetupIssues(setupDraft));
	let scopeIssue = $derived(
		setupIssues.startTokenId ?? setupIssues.totalSupply ?? setupIssues.tokenIds
	);
	let sampleMatchesScope = $derived(bootstrapSampleMatchesScope(sampleTokenId, setupDraft));
	let contractReady = $derived(
		Boolean(chain) && addressCanBeProbed && contractAddressSafetyAcknowledged
	);
	let detailsReady = $derived(!setupIssues.slug && !setupIssues.imageSourceField);
	let submitDisabled = $derived(submitting || !contractReady || Object.keys(setupIssues).length > 0);
	let setupSections = $derived([
		{
			id: 'bootstrap-contract',
			title: 'Contract',
			ready: contractReady,
			optional: false
		},
		{
			id: 'bootstrap-scope',
			title: 'Token scope',
			ready: !scopeIssue,
			optional: false
		},
		{
			id: 'bootstrap-details',
			title: 'Collection details',
			ready: detailsReady,
			optional: false
		},
		{
			id: 'bootstrap-cache',
			title: 'Image cache',
			ready: !setupIssues.maxDimension,
			optional: true
		},
		{
			id: 'bootstrap-opensea',
			title: 'OpenSea',
			ready: openSeaSlugResolved && sampleMatchesScope,
			optional: true
		}
	]);
	let firstTokenCard = $derived(firstTokenPreviewCard());
	let cachedTokenCard = $derived(cachedTokenPreviewCard());
	let animationPreviewIframeSource = $derived(resolveAnimationPreviewIframeSource());
	let animationPreviewAvailable = $derived(animationPreviewIframeSource !== null);

	onDestroy(() => {
		contractProbeRequestId += 1;
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

	function invalidateContractProbe(): void {
		probeInputsChanged = probeInputsChanged || probeStatus !== BOOTSTRAP_PROBE_UI_STATUS.Idle;
		samplePreviewOpen = false;
		contractProbeRequestId += 1;
		probeStatus = BOOTSTRAP_PROBE_UI_STATUS.Idle;
		probeResult = null;
		probeAddress = null;
		probeError = null;
		submitError = null;
		resetImageCacheEstimateState();
	}

	function resetImageCacheEstimateState(): void {
		cachePreviewOpen = false;
		imageCacheEstimateRequestId += 1;
		imageCacheEstimateStatus = imageCacheEstimateUiStatus.Idle;
		imageCacheEstimateResult = null;
		imageCacheEstimateError = null;
	}

	function setImageCacheMaxDimensionValue(value: string): void {
		imageCacheMaxDimensionDraft = value;
	}

	function setCollectionSlugInputValue(value: string): void {
		bootstrapSlug = value;
		if (collectionSlugInputElement) collectionSlugInputElement.value = value;
	}

	function readCollectionSlugInputValue(): string {
		return normalizeFieldValue(collectionSlugInputElement?.value ?? bootstrapSlug).toLowerCase();
	}

	function setImageSourceFieldValue(value: string): void {
		imageSourceField = value;
		if (imageSourceFieldInputElement) imageSourceFieldInputElement.value = value;
	}

	function readImageSourceFieldInputValue(): string {
		return normalizeFieldValue(imageSourceFieldInputElement?.value ?? imageSourceField);
	}

	function setAnimationSourceFieldValue(value: string): void {
		animationSourceField = value;
		if (animationSourceFieldInputElement) animationSourceFieldInputElement.value = value;
		animationSourceFieldInputHasValue = normalizeFieldValue(value).length > 0;
	}

	function readAnimationSourceFieldInputValue(): string {
		return normalizeFieldValue(animationSourceFieldInputElement?.value ?? animationSourceField);
	}

	function setSampleTokenIdValue(value: string): void {
		sampleTokenId = value;
		if (sampleTokenIdInputElement) sampleTokenIdInputElement.value = value;
		sampleTokenIdInputHasValue = normalizeFieldValue(value).length > 0;
	}

	function readSampleTokenIdInputValue(): string {
		// Derived validation must observe state changes when detected fields are explicitly applied.
		return normalizeFieldValue(sampleTokenId);
	}

	function onCollectionSlugInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		bootstrapSlug = target.value;
	}

	function onBootstrapAddressInput(event: Event): void {
		bootstrapAddress = (event.currentTarget as HTMLInputElement).value;
		invalidateContractProbe();
	}

	function onContractAddressSafetyAcknowledgementChange(event: Event): void {
		contractAddressSafetyAcknowledged = (event.currentTarget as HTMLInputElement).checked;
		if (!contractAddressSafetyAcknowledged) invalidateContractProbe();
	}

	function onImageSourceFieldInput(event: Event): void {
		imageSourceField = (event.currentTarget as HTMLInputElement).value;
		imageSourceFieldDirty = true;
		invalidateContractProbe();
	}

	function onAnimationSourceFieldInput(event: Event): void {
		setAnimationSourceFieldValue((event.currentTarget as HTMLInputElement).value);
		animationSourceFieldDirty = true;
		selectedBootstrapPreviewSource = BOOTSTRAP_PREVIEW_SOURCE.Image;
		invalidateContractProbe();
	}

	function onSampleTokenIdInput(event: Event): void {
		setSampleTokenIdValue((event.currentTarget as HTMLInputElement).value);
		sampleTokenIdDirty = true;
		invalidateContractProbe();
	}

	async function onProbe(): Promise<void> {
		if (!contractAddressSafetyAcknowledged || !addressCanBeProbed || !chain) return;
		const requestId = ++contractProbeRequestId;
		const submittedOpenSeaSlug = bootstrapOpenSeaSlug;
		probeInputsChanged = false;
		probeResult = null;
		probeStatus = BOOTSTRAP_PROBE_UI_STATUS.Loading;
		probeError = null;
		resetImageCacheEstimateState();
		try {
			// Submit one snapshot of the user's staged metadata inputs.
			const result = await probeBootstrapCollectionContract(
				fetch,
				chain.slug,
				normalizedBootstrapAddress,
				{
					imageSourceField: readImageSourceFieldInputValue() || null,
					animationSourceField: readAnimationSourceFieldInputValue() || null,
					sampleTokenId: readSampleTokenIdInputValue() || null
				}
			);
			if (requestId !== contractProbeRequestId) return;
			probeResult = result;
			probeAddress = result.address;
			probeStatus = BOOTSTRAP_PROBE_UI_STATUS.Ready;
			imageSourceFieldDirty = false;
			animationSourceFieldDirty = false;
			sampleTokenIdDirty = false;
			// The optional marketplace lookup uses the same explicit sample, never the scope.
			await tick();
			if (
				requestId === contractProbeRequestId &&
				sampleTokenIdResolved &&
				sampleMatchesScope &&
				openSeaEnabled &&
				bootstrapOpenSeaSlug === submittedOpenSeaSlug
			) {
				void openSeaSlugResolver?.resolveSlug();
			}
		} catch {
			if (requestId !== contractProbeRequestId) return;
			probeStatus = BOOTSTRAP_PROBE_UI_STATUS.Error;
			probeError =
				'Contract probe failed. Check the sample token ID and RPC settings, then press probe.';
		}
	}

	function onOpenSeaSlugStateChange(state: OpenSeaSlugResolverState): void {
		bootstrapOpenSeaSlug = state.slug;
		openSeaSlugResolved = state.resolved;
	}

	function isImageSourceFieldResolved(): boolean {
		if (!latestProbeMatchesAddress || !probeResult) return false;
		const resolvedField = normalizeFieldValue(probeResult.firstToken.imageSourceField);
		if (!resolvedField || !probeResult.firstToken.image) return false;
		return normalizeFieldValue(imageSourceField) === resolvedField && !imageSourceFieldDirty;
	}

	function isAnimationSourceFieldResolved(): boolean {
		if (!latestProbeMatchesAddress || !probeResult) return false;
		const resolvedField = normalizeFieldValue(probeResult.firstToken.animationSourceField);
		if (!resolvedField || !probeResult.firstToken.animationUrl) return false;
		return normalizeFieldValue(animationSourceField) === resolvedField && !animationSourceFieldDirty;
	}

	function isAnimationSourceFieldIncorrect(): boolean {
		if (!animationSourceFieldInputHasValue || animationSourceFieldDirty) return false;
		if (!latestProbeMatchesAddress || !probeResult || sampleProbeFailure) return false;
		return !isAnimationSourceFieldResolved();
	}

	function isSampleTokenIdResolved(): boolean {
		if (!latestProbeMatchesAddress || !probeResult || sampleTokenIdDirty) return false;
		const resolvedTokenId = normalizeFieldValue(probeResult.firstToken.tokenId);
		if (!resolvedTokenId || readSampleTokenIdInputValue() !== resolvedTokenId) return false;
		return bootstrapSampleOwnership(probeResult) === true;
	}

	function isSampleTokenIdIncorrect(): boolean {
		if (!sampleTokenIdInputHasValue || sampleTokenIdDirty || contractProbePending) return false;
		if (probeStatus !== BOOTSTRAP_PROBE_UI_STATUS.Ready) return false;
		return probeResult !== null && bootstrapSampleOwnership(probeResult) === false;
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
			animationUrl: firstToken.animationUrl,
			traitSummary: null,
			listingPrice: null,
			listingCurrency: null,
			attributes: [],
			hasMetadata: firstToken.metadataError === null,
			metadataUpdatedAt: null
		};
	}

	function resolveAnimationPreviewIframeSource(): TokenMediaIframeSource | null {
		const firstToken = probeResult?.firstToken;
		if (!animationSourceFieldResolved || !firstToken?.tokenId || !firstToken.animationUrl) {
			return null;
		}
		return resolveTokenMediaIframeSource(
			firstToken.animationUrl,
			null,
			tokenMediaTitle(firstToken.tokenId)
		);
	}

	function selectBootstrapPreviewSource(source: BootstrapPreviewSource): void {
		if (source === BOOTSTRAP_PREVIEW_SOURCE.Animation && !animationPreviewAvailable) {
			return;
		}
		selectedBootstrapPreviewSource = source;
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
			animationUrl: null,
			traitSummary: null,
			listingPrice: null,
			listingCurrency: null,
			attributes: [],
			hasMetadata: firstToken.metadataError === null,
			metadataUpdatedAt: null
		};
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
		resetImageCacheEstimateState();
	}

	function onImageCacheMaxDimensionInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		imageCacheMaxDimensionDraft = target.value;
		resetImageCacheEstimateState();
	}

	function onImageCacheMaxDimensionKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		void onEstimateImageCache();
	}

	function onScopeModeChange(event: Event): void {
		const mode = (event.currentTarget as HTMLSelectElement).value;
		supportsEnumerable = mode === BOOTSTRAP_ENUMERATION_MODE.Enumerable;
		if (!supportsEnumerable) {
			manualMode =
				mode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
					? BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
					: BOOTSTRAP_ENUMERATION_MODE.ManualRange;
		}
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

	function canRunImageCacheEstimate(): boolean {
		if (
			scopeIssue ||
			setupIssues.maxDimension ||
			!formDetailsReady ||
			imageCacheMode === IMAGE_CACHE_MODE.Off
		)
			return false;
		if (!probeResult?.firstToken.tokenId || !probeResult.firstToken.image) return false;
		if (!resolvedBootstrapScopeTotalSupply()) return false;
		return !imageCacheEstimatePending;
	}

	async function onEstimateImageCache(): Promise<void> {
		if (!chain || !probeResult || !canRunImageCacheEstimate()) return;
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
				error instanceof BackendApiError && [400, 422, 502].includes(error.status)
					? error.message
					: 'Image cache estimate failed. Press estimate to retry, or set Image cache mode to off.';
		}
	}

	function manualTokenIdList(): string[] {
		return bootstrapTokenIds(manualTokenIds);
	}

	function normalizedManualRangeStartTokenId(): string {
		return normalizeFieldValue(manualRangeStartTokenId);
	}

	function normalizedManualRangeTotalSupply(): string {
		const value = normalizeFieldValue(manualRangeTotalSupply);
		return /^\d+$/.test(value) && BigInt(value) > 0n ? value : '';
	}

	function resolvedBootstrapScopeTotalSupply(): string | null {
		if (scopeIssue) return null;
		if (supportsEnumerable) {
			return latestProbeMatchesAddress ? (probeResult?.totalSupply.value ?? null) : null;
		}
		if (manualMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds) {
			const tokenIds = new Set(manualTokenIdList().map((id) => BigInt(id).toString()));
			return tokenIds.size > 0 ? String(tokenIds.size) : null;
		}
		return normalizedManualRangeTotalSupply() || null;
	}

	function projectedMetadataSize(): string {
		const sampleBytes = probeResult?.firstToken.tokenUriPayloadBytes;
		const count = resolvedBootstrapScopeTotalSupply();
		return sampleBytes == null || count === null
			? 'not available'
			: formatByteSize((BigInt(sampleBytes) * BigInt(count)).toString());
	}

	function imageCacheSampleOutputValue(): string {
		if (imageCacheMode === IMAGE_CACHE_MODE.Off) return 'not cached';
		if (!imageCacheEstimateReady || !imageCacheEstimateResult) return 'not estimated';
		return formatByteSize(imageCacheEstimateResult.sampleCachedBytes);
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

	function parseImageCacheMaxDimension(): number | null {
		const raw = normalizeFieldValue(imageCacheMaxDimensionDraft);
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
		const openseaSlug =
			openSeaEnabled && openSeaSlugResolved && sampleMatchesScope ? bootstrapOpenSeaSlug : '';
		if (!slug || !address) {
			submitError = 'slug and address are required';
			return;
		}
		if (submitDisabled) {
			submitError = 'Complete the required fields in the sections above.';
			return;
		}
		const resolvedImageSourceField = readImageSourceFieldInputValue();
		if (!resolvedImageSourceField) {
			submitError = 'image source field is required';
			return;
		}
		const resolvedAnimationSourceField = readAnimationSourceFieldInputValue() || null;

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
				imageSourceField: resolvedImageSourceField,
				animationSourceField: resolvedAnimationSourceField,
				standard: 'erc721',
				metadataMode: DEFAULT_BOOTSTRAP_METADATA_MODE,
				supportsEnumerable,
				manualInput,
				imageCache: {
					selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
					imageCacheMode,
					maxDimension: imageCacheMode === IMAGE_CACHE_MODE.Off ? null : imageCacheMaxDimensionValue
				}
			});
			await goto(runHref(result.runId));
		} catch (error) {
			submitError =
				error instanceof BackendApiError && [400, 409, 422].includes(error.status)
					? error.message
					: 'Bootstrap could not be queued. Press queue bootstrap to retry.';
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

{#snippet sectionHeading(index: number)}
	{@const section = setupSections[index]}
	<div class="bootstrap-step-heading">
		<h3 id={section.id + '-heading'}>{index + 1}. {section.title} <span class="muted">{section.optional ? 'optional' : 'required'}</span></h3>
		<span class="bootstrap-step-status" class:bootstrap-step-incomplete={!section.ready && index < 4}>
			{section.optional ? (section.ready ? (index === 4 ? 'resolved' : 'configured') : (index === 4 ? 'skipped until resolved' : 'check settings')) : section.ready ? '✓ complete' : 'needs input'}
		</span>
	</div>
{/snippet}

{#snippet inProgressStatus(label: string, ariaLabel: string)}
	<span class="bootstrap-inline-progress">
		<span>{label}</span>
		<LoadingBladeBar {ariaLabel} barLength={2} />
	</span>
{/snippet}

{#snippet applySuggestion(
	value: string | null | undefined,
	current: string,
	apply: (value: string) => void
)}
	{#if latestProbeMatchesAddress && value}
		<button
			type="button"
			class="action-button-positive"
			title={`apply "${value}"`}
			disabled={value === current.trim()}
			onclick={() => apply(value)}
		>
			<span class="action-button-value">apply <code>"{value}"</code></span>
		</button>
	{/if}
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


	<div class="bootstrap-workspace">
	<form class="bootstrap-form bootstrap-create-form" onsubmit={onBootstrapFormSubmit}>
				<div class="bootstrap-contract-address-warning" role="note">
					<span class="bootstrap-contract-address-warning-icon"><WarningIcon /></span>
					<div class="bootstrap-contract-address-warning-body">
						<p>{BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_WARNING}</p>
						<label class="bootstrap-contract-address-warning-acknowledgement">
							<input class={bootstrapCheckboxClass} type="checkbox" required
								checked={contractAddressSafetyAcknowledged}
								onchange={onContractAddressSafetyAcknowledgementChange} />
							<span>{BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_ACKNOWLEDGEMENT}</span>
						</label>
					</div>
				</div>
		<fieldset class="bootstrap-form-fields" disabled={!contractAddressSafetyAcknowledged}>
			<section class="bootstrap-form-section" id={setupSections[0].id} aria-labelledby="bootstrap-contract-heading">
				{@render sectionHeading(0)}
				<div class="bootstrap-form-row">
					<label for="bootstrap-address">{@render fieldLabel('Contract address', bootstrapFieldHelp.address)}</label>
					<input id="bootstrap-address" value={bootstrapAddress} class={bootstrapInputClass}
						type="text" name="address" required oninput={onBootstrapAddressInput}
						aria-invalid={Boolean(bootstrapAddress && setupIssues.address)} aria-describedby="bootstrap-address-help" />
					<div class="bootstrap-row-actions">
						<button type="button" class="action-button-positive"
							disabled={!contractAddressSafetyAcknowledged || !addressCanBeProbed || !chain || contractProbePending}
							aria-label="probe" aria-busy={contractProbePending} onclick={() => void onProbe()}>
							{#if contractProbePending}{@render inProgressStatus('probing', 'probing contract')}{:else}probe{/if}
						</button>
						<span class="bootstrap-row-status" role="status" hidden={contractProbePending}>
							{#if probeStatus === BOOTSTRAP_PROBE_UI_STATUS.Error}
								probe failed
							{:else if latestProbeMatchesAddress}
								{sampleProbeFailure ? 'check incomplete' : 'probe complete'}
							{:else}
								{probeInputsChanged ? 'inputs changed — probe again' : 'not checked'}
							{/if}
						</span>
					</div>
					<p id="bootstrap-address-help" class="bootstrap-row-note muted">
						{#if setupIssues.address}{setupIssues.address}
						{:else if !contractAddressSafetyAcknowledged}Confirm the contract address above before probing or queueing.
						{:else}probe checks the current sample and media fields. After editing them, press probe again.{/if}
					</p>
				</div>
				<div class="bootstrap-form-row">
					<label for="bootstrap-sample">{@render fieldLabel('Sample token ID', bootstrapFieldHelp.sampleTokenId)}</label>
					<input id="bootstrap-sample" bind:this={sampleTokenIdInputElement} value={sampleTokenId}
						class={bootstrapInputClass} type="text" inputmode="numeric" name="sampleTokenId"
						oninput={onSampleTokenIdInput} aria-describedby="bootstrap-sample-help" />
					<div class="bootstrap-row-actions">
						{@render applySuggestion(probeResult && bootstrapSampleOwnership(probeResult) === true
							? probeResult.firstToken.tokenId : null, sampleTokenId, setSampleTokenIdValue)}
						{#if sampleTokenIdResolved}
							<span class="bootstrap-row-status">owner confirmed</span>
						{:else if sampleTokenIdIncorrect}
							<span class="bootstrap-row-status">no owner found</span>
						{:else}
							<span class="bootstrap-row-status">optional</span>
						{/if}
					</div>
					<p id="bootstrap-sample-help" class="bootstrap-row-note muted">
						{#if sampleTokenId.trim() && !sampleMatchesScope && !scopeIssue}
							This sample is outside the selected scope. Choose one inside it to set up OpenSea; bootstrap can proceed.
						{:else}
							Use one existing token for checks and previews, or leave blank for probe to find a sample.
						{/if}
					</p>
				</div>
				{#if probeError || sampleProbeFailure}
					<div class="bootstrap-section-note bootstrap-check-warning" role="alert">
						<p>{probeError ?? sampleProbeFailure}</p>
						<p class="muted">You can still queue bootstrap with the required fields below. Unavailable metadata or images may remain missing.</p>
					</div>
				{/if}
				{#if latestProbeMatchesAddress && probeResult}
					<div class="bootstrap-form-row">
						<span class="bootstrap-form-label-cell">Contract checks</span>
						<div class="bootstrap-read-value">
							{probeResult.contractName ?? 'Name unavailable'} · ERC721 {interfaceLabel(probeResult.erc721.supported)}
						</div>
						<div class="bootstrap-row-actions">
							<button type="button" class="action-button-positive" aria-expanded={probeDetailsOpen}
								onclick={() => probeDetailsOpen = !probeDetailsOpen}>{probeDetailsOpen ? 'hide checks' : 'view checks'}</button>
						</div>
					</div>
					{#if probeDetailsOpen}
						<div class="bootstrap-form-row">
							{@render fieldLabel('ERC721 interface', bootstrapFieldHelp.erc721Interface)}
							<div class="bootstrap-read-value">{interfaceLabel(probeResult.erc721.supported)}</div>
						</div>
						<div class="bootstrap-form-row">
							{@render fieldLabel('ERC721Enumerable interface', bootstrapFieldHelp.enumerableInterface)}
							<div class="bootstrap-read-value">{interfaceLabel(probeResult.enumerable.supported)}</div>
						</div>
						<div class="bootstrap-form-row">
							<span class="bootstrap-form-label-cell">Metadata (1 token)</span>
							<div class="bootstrap-read-value mono">{formatByteSize(probeResult.firstToken.tokenUriPayloadBytes)}</div>
						</div>
						<div class="bootstrap-form-row">
							<span class="bootstrap-form-label-cell">Est. metadata (selected scope)</span>
							<div class="bootstrap-read-value mono">{projectedMetadataSize()}</div>
						</div>
						{#if probeResult.proxy}
							<div class="bootstrap-form-row">
								<span class="bootstrap-form-label-cell">Implementation address</span>
								<div class="bootstrap-read-value mono">{probeResult.proxy.implementationAddress}</div>
							</div>
						{/if}
					{/if}
				{/if}
			</section>

			<section class="bootstrap-form-section" id={setupSections[1].id} aria-labelledby="bootstrap-scope-heading">
				{@render sectionHeading(1)}
				<div class="bootstrap-form-row">
					<label for="bootstrap-scope-mode">{@render fieldLabel('Token scope', bootstrapFieldHelp.manualMode)}</label>
					<select id="bootstrap-scope-mode" class={bootstrapSelectClass}
						value={supportsEnumerable ? BOOTSTRAP_ENUMERATION_MODE.Enumerable : manualMode}
						onchange={onScopeModeChange}>
						<option value={BOOTSTRAP_ENUMERATION_MODE.ManualRange}>Token range</option>
						<option value={BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds}>Token ID list</option>
						<option value={BOOTSTRAP_ENUMERATION_MODE.Enumerable}>Entire contract (ERC721Enumerable)</option>
					</select>
					<div class="bootstrap-row-actions">
						<span class="bootstrap-row-status">{supportsEnumerable ? 'all contract tokens' : 'collection scope'}</span>
					</div>
				</div>
				{#if supportsEnumerable}
					<p class="bootstrap-section-note muted">
						Includes every token on this contract. For one project on a shared contract, choose Token range or Token ID list.
					</p>
					{#if latestProbeMatchesAddress && probeResult?.enumerable.supported !== true}
						<p class="bootstrap-section-note bootstrap-check-warning">
							ERC721Enumerable support was not confirmed. Choose a range or list if this contract cannot enumerate tokens; you can still queue the selected scope.
						</p>
					{/if}
				{:else if manualMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds}
					<div class="bootstrap-form-row bootstrap-form-row-textarea">
						<label for="bootstrap-token-ids">{@render fieldLabel('Token IDs', bootstrapFieldHelp.tokenIds)}</label>
						<textarea id="bootstrap-token-ids" value={manualTokenIds} class={bootstrapTextareaClass}
							rows="3" required oninput={onManualTokenIdsInput}
							aria-invalid={Boolean(manualTokenIds && setupIssues.tokenIds)} aria-describedby="bootstrap-token-ids-help"></textarea>
						<div class="bootstrap-row-actions"><span class="bootstrap-row-status">required</span></div>
						<p id="bootstrap-token-ids-help" class="bootstrap-row-note muted">
							{setupIssues.tokenIds ?? `${new Set(manualTokenIdList()).size} token IDs selected.`}
						</p>
					</div>
				{:else}
					<div class="bootstrap-form-row">
						<label for="bootstrap-range-start">{@render fieldLabel('First token ID', bootstrapFieldHelp.startTokenId)}</label>
						<input id="bootstrap-range-start" value={manualRangeStartTokenId} class={bootstrapInputClass}
							type="text" inputmode="numeric" required oninput={onManualRangeStartTokenIdInput}
							aria-invalid={Boolean(setupIssues.startTokenId)} aria-describedby="bootstrap-range-help" />
						<div class="bootstrap-row-actions"><span class="bootstrap-row-status">required</span></div>
					</div>
					<div class="bootstrap-form-row">
						<label for="bootstrap-range-count">{@render fieldLabel('Token count', bootstrapFieldHelp.manualRangeTotalSupply)}</label>
						<input id="bootstrap-range-count" value={manualRangeTotalSupply} class={bootstrapInputClass}
							type="text" inputmode="numeric" required oninput={onManualRangeTotalSupplyInput}
							aria-invalid={Boolean(manualRangeTotalSupply && setupIssues.totalSupply)} aria-describedby="bootstrap-range-help" />
						<div class="bootstrap-row-actions">
							{@render applySuggestion(probeResult?.totalSupply.bootstrapRangeValue?.toString(), manualRangeTotalSupply, (value) => {
								manualRangeTotalSupply = value;
								resetImageCacheEstimateState();
							})}
							<span class="bootstrap-row-status">{latestProbeMatchesAddress && probeResult?.totalSupply.bootstrapRangeValue ? 'contract supply suggestion' : 'required'}</span>
						</div>
						<p id="bootstrap-range-help" class="bootstrap-row-note muted">
							{scopeIssue ?? `Token IDs ${manualRangeStartTokenId.trim()}–${BigInt(manualRangeStartTokenId.trim()) + BigInt(manualRangeTotalSupply.trim()) - 1n}, including unminted IDs.`}
						</p>
					</div>
				{/if}
				{#if latestProbeMatchesAddress && probeResult?.totalSupply.value}
					<div class="bootstrap-form-row">
						{@render fieldLabel('Contract total supply', bootstrapFieldHelp.contractTotalSupply)}
						<div class="bootstrap-read-value mono">{probeResult.totalSupply.value}</div>
						<div class="bootstrap-row-actions"><span class="bootstrap-row-status">reported by contract</span></div>
						<p class="bootstrap-row-note muted">Contract supply does not define the first ID or the size of one project on a shared contract.</p>
					</div>
				{/if}
			</section>

			<section class="bootstrap-form-section" id={setupSections[2].id} aria-labelledby="bootstrap-details-heading">
				{@render sectionHeading(2)}
				<div class="bootstrap-form-row">
					<label for="bootstrap-slug">{@render fieldLabel('Collection slug', bootstrapFieldHelp.slug)}</label>
					<input id="bootstrap-slug" bind:this={collectionSlugInputElement} value={bootstrapSlug}
						class={bootstrapInputClass} type="text" name="slug" required oninput={onCollectionSlugInput}
						aria-invalid={Boolean(bootstrapSlug && setupIssues.slug)} aria-describedby="bootstrap-slug-help" />
					<div class="bootstrap-row-actions">
						{@render applySuggestion(contractNameToBootstrapSlug(probeResult?.contractName), bootstrapSlug, setCollectionSlugInputValue)}
					</div>
					<p id="bootstrap-slug-help" class="bootstrap-row-note muted">
						{setupIssues.slug ?? 'Local name used in ArtGod URLs. Review suggestions for shared contracts.'}
					</p>
				</div>
				<div class="bootstrap-form-row">
					<label for="bootstrap-image-field">{@render fieldLabel('Image source field', bootstrapFieldHelp.imageSourceField)}</label>
					<input id="bootstrap-image-field" bind:this={imageSourceFieldInputElement} value={imageSourceField}
						class={bootstrapInputClass} type="text" name="imageSourceField" required oninput={onImageSourceFieldInput}
						aria-describedby="bootstrap-image-help" />
					<div class="bootstrap-row-actions">
						{@render applySuggestion(probeResult?.firstToken.imageSourceField, imageSourceField, setImageSourceFieldValue)}
						{#if imageSourceFieldResolved}<span class="bootstrap-row-status">found in sample</span>{/if}
					</div>
					{#if setupIssues.imageSourceField}
						<p id="bootstrap-image-help" class="bootstrap-row-note muted">{setupIssues.imageSourceField}</p>
					{:else if !imageSourceFieldResolved}
						<p id="bootstrap-image-help" class="bootstrap-row-note muted">
							{#if latestProbeMatchesAddress && !sampleProbeFailure}
								No image found in this field. Edit it and press probe again, or queue the entered field.
							{:else}
								Not checked. probe can check this field; bootstrap uses the value entered.
							{/if}
						</p>
					{/if}
				</div>
				<div class="bootstrap-form-row">
					<label for="bootstrap-animation-field">{@render fieldLabel('Animation source field (optional)', bootstrapFieldHelp.animationSourceField)}</label>
					<input id="bootstrap-animation-field" bind:this={animationSourceFieldInputElement} value={animationSourceField}
						class={bootstrapInputClass} type="text" name="animationSourceField" oninput={onAnimationSourceFieldInput} />
					<div class="bootstrap-row-actions">
						{@render applySuggestion(probeResult?.firstToken.animationSourceField, animationSourceField, setAnimationSourceFieldValue)}
						{#if animationSourceFieldResolved}<span class="bootstrap-row-status">found in sample</span>
						{:else if animationSourceFieldIncorrect}<span class="bootstrap-row-status">not found in sample</span>
						{:else if !animationSourceField}<span class="bootstrap-row-status">skip animation</span>{/if}
					</div>
				</div>
				{#if formDetailsReady && firstTokenCard}
					<div class="bootstrap-form-row">
						<span class="bootstrap-form-label-cell">Sample preview</span>
						<div class="bootstrap-read-value">Token #{firstTokenCard.tokenId}</div>
						<div class="bootstrap-row-actions">
							<button type="button" class="action-button-positive" aria-expanded={samplePreviewOpen}
								onclick={() => samplePreviewOpen = !samplePreviewOpen}>{samplePreviewOpen ? 'hide preview' : 'preview sample'}</button>
						</div>
					</div>
					{#if samplePreviewOpen}
						<div class="bootstrap-setup-preview">
							<div class="secondary-tabs bootstrap-preview-source-tabs" aria-label="Sample token preview source">
								<button type="button" class:secondary-tab-active={selectedBootstrapPreviewSource === BOOTSTRAP_PREVIEW_SOURCE.Image}
									disabled={selectedBootstrapPreviewSource === BOOTSTRAP_PREVIEW_SOURCE.Image}
									onclick={() => selectBootstrapPreviewSource(BOOTSTRAP_PREVIEW_SOURCE.Image)}>image</button>
								{#if animationPreviewAvailable}
									<button type="button" class:secondary-tab-active={selectedBootstrapPreviewSource === BOOTSTRAP_PREVIEW_SOURCE.Animation}
										disabled={selectedBootstrapPreviewSource === BOOTSTRAP_PREVIEW_SOURCE.Animation}
										onclick={() => selectBootstrapPreviewSource(BOOTSTRAP_PREVIEW_SOURCE.Animation)}>animation</button>
								{/if}
							</div>
							<aside class="bootstrap-token-card-pane" aria-label="Token image preview">
								{#if selectedBootstrapPreviewSource === BOOTSTRAP_PREVIEW_SOURCE.Animation && animationPreviewIframeSource}
									<div class="bootstrap-animation-preview-frame-wrap">
										<TokenMediaFrame className="bootstrap-animation-preview-frame" iframeSource={animationPreviewIframeSource}
											hideScrollbars title={`${tokenMediaTitle(firstTokenCard.tokenId)} animation preview`} />
									</div>
								{:else}
									<div class="bootstrap-probe-token-card" data-testid={TEST_IDS.BootstrapProbeTokenCard}>
										<TokenCardTile {chain} collection={null} token={firstTokenCard} href="#"
											selectedMediaMode={COLLECTION_MEDIA_MODES.Snapshot} availableMediaModes={bootstrapPreviewMediaModes}
											{tokenPreview} showMeta={false} />
									</div>
								{/if}
							</aside>
						</div>
					{/if}
				{/if}
			</section>

			<section class="bootstrap-form-section" id={setupSections[3].id} aria-labelledby="bootstrap-cache-heading">
				{@render sectionHeading(3)}
				<div class="bootstrap-form-row">
					<label for="bootstrap-cache-mode">{@render fieldLabel('Image cache mode', bootstrapFieldHelp.imageCacheMode)}</label>
					<select id="bootstrap-cache-mode" value={imageCacheMode} class={bootstrapSelectClass} onchange={onImageCacheModeChange}>
						{#each [IMAGE_CACHE_MODE.Off, IMAGE_CACHE_MODE.CacheOnce, IMAGE_CACHE_MODE.RefreshOnMetadata] as mode}
							<option value={mode}>{imageCacheModeLabel(mode)}</option>
						{/each}
					</select>
					<div class="bootstrap-row-actions"><span class="bootstrap-row-status">{imageCacheMode === IMAGE_CACHE_MODE.Off ? 'no local image files' : 'optional estimate'}</span></div>
				</div>
				{#if imageCacheMode !== IMAGE_CACHE_MODE.Off}
					<div class="bootstrap-form-row">
						<label for="bootstrap-cache-dimension">{@render fieldLabel('Max dimension (px)', bootstrapFieldHelp.imageMaxDimension)}</label>
						<input id="bootstrap-cache-dimension" value={imageCacheMaxDimensionDraft} class={bootstrapInputClass}
							type="text" inputmode="numeric" oninput={onImageCacheMaxDimensionInput}
							onkeydown={onImageCacheMaxDimensionKeydown} aria-invalid={Boolean(setupIssues.maxDimension)}
							aria-describedby="bootstrap-cache-help" />
						<div class="bootstrap-row-actions">
							<button type="button" class="action-button-positive" disabled={!imageCacheEstimateCanRun}
								aria-label="estimate" aria-busy={imageCacheEstimatePending} onclick={() => void onEstimateImageCache()}>
								{#if imageCacheEstimatePending}{@render inProgressStatus('estimating', 'estimating image cache size')}{:else}estimate{/if}
							</button>
							<span class="bootstrap-row-status" role="status" hidden={imageCacheEstimatePending}>
								{#if imageCacheEstimateReady}estimated
								{:else if imageCacheEstimateFailed}estimate failed
								{:else}not estimated{/if}
							</span>
						</div>
						<p id="bootstrap-cache-help" class="bootstrap-row-note muted">
							{setupIssues.maxDimension ?? (imageCacheEstimateCanRun || imageCacheEstimateReady || imageCacheEstimatePending
								? 'Estimate is optional. Leave the dimension blank to keep original image dimensions.'
								: 'To estimate, probe and apply the sample and image field, then set a token count. You can queue without an estimate.')}
						</p>
					</div>
				{/if}
				{#if imageCacheEstimateError}
					<p class="bootstrap-section-note bootstrap-check-warning" role="alert">{imageCacheEstimateError} Bootstrap can still be queued.</p>
				{/if}
				{#if imageCacheEstimateReady}
					<div class="bootstrap-form-row">
						<span class="bootstrap-form-label-cell">Source image (1 token)</span>
						<div class="bootstrap-read-value mono">
							{formatByteSize(imageCacheEstimateResult?.sampleSourceBytes)}
							{#if imageCacheEstimateResult?.sourceWidth && imageCacheEstimateResult.sourceHeight}
								· {imageCacheEstimateResult.sourceWidth} x {imageCacheEstimateResult.sourceHeight}px
							{/if}
						</div>
					</div>
					<div class="bootstrap-form-row">
						<span class="bootstrap-form-label-cell">Cached image (1 token)</span>
						<div class="bootstrap-read-value mono">{imageCacheSampleOutputValue()} · {imageCacheOutputDimensionsValue()}</div>
						<div class="bootstrap-row-actions">
							<button type="button" class="action-button-positive" aria-expanded={cachePreviewOpen}
								onclick={() => cachePreviewOpen = !cachePreviewOpen}>{cachePreviewOpen ? 'hide preview' : 'preview cached image'}</button>
						</div>
					</div>
					<div class="bootstrap-form-row">
						<span class="bootstrap-form-label-cell">Estimated cache (selected scope)</span>
						<div class="bootstrap-read-value mono">{imageCacheProjectedOutputValue()} · {resolvedBootstrapScopeTotalSupply()} tokens</div>
					</div>
					{#if cachePreviewOpen && cachedTokenCard}
						<div class="bootstrap-setup-preview">
							<aside class="bootstrap-token-card-pane" aria-label="Cached token image preview">
								<div class="bootstrap-probe-token-card" data-testid={TEST_IDS.BootstrapCacheTokenCard}>
									<TokenCardTile {chain} collection={null} token={cachedTokenCard} href="#"
										selectedMediaMode={COLLECTION_MEDIA_MODES.Snapshot} availableMediaModes={bootstrapPreviewMediaModes}
										{tokenPreview} showMeta={false} />
								</div>
							</aside>
							<p class="muted">{imageCachePreviewMessage}</p>
						</div>
					{/if}
				{/if}
			</section>

			<section class="bootstrap-form-section" id={setupSections[4].id} aria-labelledby="bootstrap-opensea-heading">
				{@render sectionHeading(4)}
				<div class="bootstrap-form-row">
					<label for="bootstrap-opensea-slug">{@render fieldLabel('OpenSea slug', bootstrapFieldHelp.openseaSlug)}</label>
					<OpenSeaSlugResolverControl chainSlug={chain?.slug ?? null} contractAddress={normalizedBootstrapAddress}
						bind:this={openSeaSlugResolver} {sampleTokenId} initialSlug="" inputId="bootstrap-opensea-slug"
						inputClass={bootstrapInputClass} gridLayout openSeaEnabled={openSeaEnabled && contractAddressSafetyAcknowledged} onStateChange={onOpenSeaSlugStateChange}
						disabledReason={!contractAddressSafetyAcknowledged ? null : openSeaDisabledReason ? `${openSeaDisabledReason}. ${openSeaSetupMessage}` : openSeaSetupMessage} />
				</div>
				<p class="bootstrap-section-note muted">
					{#if openSeaSlugResolved && sampleMatchesScope}
						Included in this bootstrap. The slug identifies the sample's OpenSea collection.
					{:else if openSeaSlugResolved}
						The sample is outside the selected scope. OpenSea will be skipped; choose a sample inside the scope and resolve again.
					{:else}
						Optional for onchain bootstrap. Resolve a sample from your scope to enable OpenSea sync and bidding, or set it up later.
					{/if}
				</p>
			</section>

			<div class="bootstrap-setup-submit">
				<p class="muted" role="status">
					{#if !submitDisabled}Required setup complete.
					{:else if submitting}Queueing bootstrap…
					{:else}Check the highlighted sections above.{/if}
				</p>
				<button type="button" class="action-button-positive" disabled={submitDisabled} aria-label="queue bootstrap" aria-busy={submitting} onclick={() => void onSubmitBootstrap()}>
					{#if submitting}{@render inProgressStatus('queueing', 'queueing bootstrap')}{:else}queue bootstrap{/if}
				</button>
				{#if submitError}<p class="bootstrap-section-note bootstrap-check-warning" role="alert">{submitError}</p>{/if}
			</div>
		</fieldset>
	</form>
	<aside class="bootstrap-metadata-panel" aria-label="tokenURI response">
		<header class="bootstrap-metadata-heading">
			<h2 class="panel-title">tokenURI response</h2>
			{#if latestProbeMatchesAddress && probeResult?.firstToken.tokenId}
				<span class="muted">token #{probeResult.firstToken.tokenId} · {formatByteSize(probeResult.firstToken.tokenUriPayloadBytes)}</span>
			{/if}
		</header>
		{#if latestProbeMatchesAddress && probeResult?.firstToken.tokenUriPayload != null}
			<JsonPayloadPreview text={probeResult.firstToken.tokenUriPayload} />
		{:else}
			<p class="muted">{contractProbePending ? 'waiting for metadata…' : probeError || sampleProbeFailure ? 'No response available. Retry probe.' : 'probe to load metadata'}</p>
		{/if}
	</aside>
	</div>

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
