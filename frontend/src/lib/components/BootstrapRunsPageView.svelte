<script lang="ts">
	import { normalizeEvmTokenId } from '@artgod/shared/evm/token-id';
	import { BOOTSTRAP_CONVENTIONAL_TOKEN_IDS } from '@artgod/shared/bootstrap/sample-selection';
	import { inspectBootstrapMetadata } from '@artgod/shared/bootstrap/metadata';
	import type { BootstrapSampleInspectionResponse } from '@artgod/shared/bootstrap/probe';
	import type { BootstrapScope } from '@artgod/shared/bootstrap/scope';
	import { bootstrapScopeTokenCount } from '@artgod/shared/bootstrap/scope';
	import { goto } from '$app/navigation';
	import { onDestroy, tick, untrack } from 'svelte';
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
		probeBootstrapCollectionContract,
		inspectBootstrapSample
	} from '$lib/backend-api';
	import {
		BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_ACKNOWLEDGEMENT,
		BOOTSTRAP_PROBE_UI_STATUS,
		BOOTSTRAP_CONTRACT_ADDRESS_SAFETY_WARNING,
		bootstrapSampleFailure,
		bootstrapRangeSuggestions,
		contractNameToBootstrapSlug,
		formatByteSize,
		isBootstrapProbeableAddress,
		normalizeBootstrapAddress
	} from '$lib/bootstrap-contract-probe';
	import { DEFAULT_BOOTSTRAP_METADATA_MODE } from '$lib/bootstrap-metadata-mode';
	import { openseaCollectionHref, openseaItemHref, parseNftUrl } from '$lib/marketplace-links';
	import { updateFlash } from '$lib/update-flash';
	import {
		bootstrapSetupScope,
		bootstrapSetupIssues,
		bootstrapSampleMatchesScope,
		type BootstrapSetupDraft
	} from '$lib/bootstrap-setup';
	import ListPagesTabs from '$lib/components/ListPagesTabs.svelte';
	import InfoTooltip from '$lib/components/InfoTooltip.svelte';
	import LoadingBladeBar from '$lib/components/LoadingBladeBar.svelte';
	import OpenSeaSlugResolverControl from '$lib/components/OpenSeaSlugResolverControl.svelte';
	import TokenCardTile from '$lib/components/TokenCardTile.svelte';
	import TokenMediaFrame from '$lib/components/TokenMediaFrame.svelte';
	import WarningIcon from '$lib/components/WarningIcon.svelte';
	import BootstrapOperationLog from '$lib/components/BootstrapOperationLog.svelte';
	import { appendBootstrapOutput, emptyBootstrapLog, type BootstrapRequestOutput } from '$lib/bootstrap-output';
	import {
		BOOTSTRAP_ACTION_LABEL as Action,
		BOOTSTRAP_OPERATION,
		BOOTSTRAP_OUTPUT_STEP,
		BOOTSTRAP_OUTPUT_STATUS,
		BOOTSTRAP_QUEUE_RESPONSE_UNAVAILABLE_MESSAGE,
		type BootstrapOperation,
		type BootstrapProgressRecord
	} from '@artgod/shared/bootstrap/operation-output';
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
	const openSeaSetupMessage = `Set ${OPENSEA_API_KEY_ENV} in Admin, then fully restart the app.`;
	const imageCachePreviewMessage =
		'This preview was generated with the selected cache settings. If it looks wrong or does not render, choose caching: off.';
	const bootstrapPreviewMediaModes: ApiCollectionMediaMode[] = [
		COLLECTION_MEDIA_MODE_OPTIONS.Snapshot
	];
	const tokenPreview = getTokenPreviewController();
	const bootstrapFieldHelp = {
		address:
			'Paste a contract address or an NFT URL containing <contract address>/<decimal token ID>. A URL fills this address and Sample token ID. The website is ignored; the selected chain and token scope stay unchanged.',
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
		imageCacheMode:
			'Whether to store token images locally, and when to refresh them. Onchain collections often need caching off. Run estimate and check the resized preview before choosing.',
		imageMaxDimension:
			'Maximum cached image width or height in pixels. Leave blank to keep original dimensions.',
		manualMode:
			'Choose this collection’s token range or explicit token IDs. Entire contract uses ERC721Enumerable to include all tokens on the contract.',
		tokenIds: 'Required explicit token IDs, separated by commas or whitespace.',
		startTokenId: 'First token ID in the declared range, including IDs that are not yet minted.',
		manualRangeTotalSupply:
			'Number of IDs in the range, including unminted IDs. Last ID = first ID + token count - 1.'
	} as const;

	let bootstrapSlug = $state('');
	// Only a slug filled automatically from OpenSea follows sample/scope invalidation.
	let autoFilledCollectionSlug: string | null = null;
	let operationLog = $state(emptyBootstrapLog());
	const operationControllers = new Map<BootstrapOperation, AbortController>();
	function recordOutput(record: BootstrapProgressRecord): void {
		if (contractAddressSafetyAcknowledged) operationLog = appendBootstrapOutput(operationLog, record);
	}
	function outputRequest(
		operation: BootstrapOperation,
		current: () => boolean,
		onOutput?: (record: BootstrapProgressRecord) => void
	): BootstrapRequestOutput {
		operationControllers.get(operation)?.abort();
		const controller = new AbortController();
		operationControllers.set(operation, controller);
		return { signal: controller.signal, onOutput: record => {
			if (!controller.signal.aborted && current()) {
				recordOutput(record);
				onOutput?.(record);
			}
		} };
	}
	let collectionSlugInputElement = $state<HTMLInputElement | null>(null);
	let bootstrapAddress = $state('');
	let contractAddressSafetyAcknowledged = $state(false);
	let imageSourceField = $state('');
	let imageSourceFieldInputElement = $state<HTMLInputElement | null>(null);
	let animationSourceField = $state('');
	let animationSourceFieldInputElement = $state<HTMLInputElement | null>(null);
	let sampleTokenId = $state('');
	let sampleTokenIdInputElement = $state<HTMLInputElement | null>(null);
	let selectedBootstrapPreviewSource = $state<BootstrapPreviewSource>(BOOTSTRAP_PREVIEW_SOURCE.Image);
	let bootstrapOpenSeaSlug = $state('');
	let openSeaSlugResolved = $state(false);
	let openSeaSlugPending = $state(false);
	let entireContractSelected = $state(false);
	let manualMode = $state<BootstrapManualEnumerationMode>(BOOTSTRAP_ENUMERATION_MODE.ManualRange);
	let manualTokenIds = $state('');
	let manualRangeStartTokenId = $state('');
	let manualRangeTotalSupply = $state('');
	let imageCacheMode = $state<ApiImageCacheMode>(IMAGE_CACHE_MODE.CacheOnce);
	let imageCacheMaxDimensionDraft = $state(String(BOOTSTRAP_IMAGE_CACHE_DEFAULT_DIMENSION));
	let submitting = $state(false);
	let submitError = $state<string | null>(null);
	let probeStatus = $state<
		(typeof BOOTSTRAP_PROBE_UI_STATUS)[keyof typeof BOOTSTRAP_PROBE_UI_STATUS]
	>(BOOTSTRAP_PROBE_UI_STATUS.Idle);
	let probeResult = $state<BootstrapContractProbeApiResponse | null>(null);
	let sampleResult = $state<BootstrapSampleInspectionResponse | null>(null);
	let sampleStatus = $state<
		(typeof BOOTSTRAP_PROBE_UI_STATUS)[keyof typeof BOOTSTRAP_PROBE_UI_STATUS]
	>(BOOTSTRAP_PROBE_UI_STATUS.Idle);
	let sampleError = $state<string | null>(null);
	let sampleRequestId = 0;
	let observedChainRef: string | null = null;
	let probeError = $state<string | null>(null);
	let probeAddress = $state<string | null>(null);
	let imageCacheEstimateStatus = $state<ImageCacheEstimateUiStatus>(imageCacheEstimateUiStatus.Idle);
	let imageCacheEstimateResult = $state<BootstrapImageCacheEstimateApiResponse | null>(null);
	let imageCacheEstimateError = $state<string | null>(null);
	let openSeaSlugResolver: OpenSeaSlugResolverControl | undefined = $state();
	let contractProbeRequestId = 0;
	let probeInputsChanged = $state(false);
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
		probeResult !== null &&
			probeResult.chain.slug === chain?.slug &&
			probeAddress === normalizedBootstrapAddress
	);
	let contractProbePending = $derived(probeStatus === BOOTSTRAP_PROBE_UI_STATUS.Loading);
	let imageSourceFieldResolved = $derived(isImageSourceFieldResolved());
	let sourceFieldsReady = $derived(sampleResult !== null && imageSourceFieldResolved);
	let animationSourceFieldResolved = $derived(isAnimationSourceFieldResolved());
	let sampleTokenIdResolved = $derived(isSampleTokenIdResolved());
	let samplePending = $derived(sampleStatus === BOOTSTRAP_PROBE_UI_STATUS.Loading);
	let metadataSuggestions = $derived(
		inspectBootstrapMetadata({
			text: sampleResult?.sample.tokenUriPayload ?? null,
			ipfsGatewayOrigin: sampleResult?.ipfsGatewayOrigin ?? ''
		})
	);
	let selectedMetadata = $derived(
		inspectBootstrapMetadata({
			text: sampleResult?.sample.tokenUriPayload ?? null,
			ipfsGatewayOrigin: sampleResult?.ipfsGatewayOrigin ?? '',
			imageSourceField,
			animationSourceField
		})
	);
	let sample = $derived(sampleResult ? { ...sampleResult.sample, ...selectedMetadata } : null);
	let effectiveSampleTokenId = $derived(
		sampleTokenId.trim() ? (normalizeEvmTokenId(sampleTokenId) ?? '') : (sample?.tokenId ?? '')
	);
	let openSeaCollectionHref = $derived(openseaCollectionHref(bootstrapOpenSeaSlug));
	let openSeaSampleHref = $derived(openseaItemHref({
		chainSlug: chain?.slug ?? null,
		collectionAddress: addressCanBeProbed ? normalizedBootstrapAddress : null,
		tokenId: effectiveSampleTokenId
	}));
	let sampleProbeFailure = $derived(sampleError ?? (sample ? bootstrapSampleFailure(sample) : null));
	let imageCacheSuggestion = $derived(
		sampleResult?.imageCacheSuggestion.extensionKey &&
			JSON.stringify(sampleResult.scope) === JSON.stringify(currentScope())
			? sampleResult.imageCacheSuggestion
			: null
	);
	let formDetailsReady = $derived(sourceFieldsReady && sampleTokenIdResolved && !sampleProbeFailure);
	let imageCacheEstimatePending = $derived(
		imageCacheEstimateStatus === imageCacheEstimateUiStatus.Loading
	);
	let imageCacheEstimateReady = $derived(
		imageCacheEstimateStatus === imageCacheEstimateUiStatus.Ready && imageCacheEstimateResult !== null
	);
	let imageCacheEstimateCanRun = $derived(canRunImageCacheEstimate());
	let setupDraft: BootstrapSetupDraft = $derived({
		address: bootstrapAddress,
		slug: bootstrapSlug,
		imageSourceField,
		scopeMode: entireContractSelected ? BOOTSTRAP_ENUMERATION_MODE.Enumerable : manualMode,
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
	let sampleMatchesScope = $derived(bootstrapSampleMatchesScope(effectiveSampleTokenId, setupDraft));
	let sampleScopeConflict = $derived(Boolean(effectiveSampleTokenId && (sample || openSeaSlugResolved) && !sampleMatchesScope));
	let projectScope = $derived(sampleResult?.projectScope ?? null);
	let rangeSuggestions = $derived(bootstrapRangeSuggestions(latestProbeMatchesAddress ? probeResult : null, projectScope));
	let likelySharedContract = $derived(Boolean(projectScope) || (latestProbeMatchesAddress && Boolean(probeResult?.sharedContract)));
	let contractSlugSuggestion = $derived(latestProbeMatchesAddress && !likelySharedContract
		? contractNameToBootstrapSlug(probeResult?.contractName) : '');
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
	let sampleTokenCard = $derived(sampleTokenPreviewCard());
	let cachedTokenCard = $derived(cachedTokenPreviewCard());
	let animationPreviewIframeSource = $derived(resolveAnimationPreviewIframeSource());
	let animationPreviewAvailable = $derived(animationPreviewIframeSource !== null);

	$effect(() => {
		const next = chain?.slug ?? null;
		if (next !== observedChainRef) {
			observedChainRef = next;
			untrack(invalidateContractProbe);
		}
	});

	onDestroy(() => {
		for (const controller of operationControllers.values()) controller.abort();
		sampleRequestId += 1;
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
		for (const controller of operationControllers.values()) controller.abort();
		operationLog = emptyBootstrapLog();
		probeInputsChanged = probeInputsChanged || probeStatus !== BOOTSTRAP_PROBE_UI_STATUS.Idle;
		contractProbeRequestId += 1;
		probeStatus = BOOTSTRAP_PROBE_UI_STATUS.Idle;
		probeResult = null;
		probeAddress = null;
		probeError = null;
		invalidateSample();
		submitError = null;
		resetImageCacheEstimateState();
	}

	function invalidateSample(): void {
		clearAutoFilledCollectionSlug();
		invalidateOpenSeaResolution();
		operationControllers.get(BOOTSTRAP_OPERATION.Inspect)?.abort();
		sampleRequestId += 1;
		sampleResult = null;
		sampleStatus = BOOTSTRAP_PROBE_UI_STATUS.Idle;
		sampleError = null;
		resetImageCacheEstimateState();
	}

	function currentScope(): BootstrapScope | null {
		try {
			return bootstrapSetupScope(setupDraft);
		} catch {
			return null;
		}
	}

	function resetImageCacheEstimateState(): void {
		operationControllers.get(BOOTSTRAP_OPERATION.Estimate)?.abort();
		imageCacheEstimateRequestId += 1;
		imageCacheEstimateStatus = imageCacheEstimateUiStatus.Idle;
		imageCacheEstimateResult = null;
		imageCacheEstimateError = null;
	}

	function setImageCacheMaxDimensionValue(value: string): void {
		imageCacheMaxDimensionDraft = value;
	}

	function setCollectionSlugInputValue(value: string): void {
		autoFilledCollectionSlug = null;
		bootstrapSlug = value;
		if (collectionSlugInputElement) collectionSlugInputElement.value = value;
	}

	function readCollectionSlugInputValue(): string {
		return normalizeFieldValue(collectionSlugInputElement?.value ?? bootstrapSlug).toLowerCase();
	}

	function clearAutoFilledCollectionSlug(): void {
		if (autoFilledCollectionSlug !== null && bootstrapSlug === autoFilledCollectionSlug) {
			setCollectionSlugInputValue('');
		}
		autoFilledCollectionSlug = null;
	}

	function invalidateOpenSeaResolution(): void {
		openSeaSlugResolver?.invalidate();
		openSeaSlugResolved = false;
		openSeaSlugPending = false;
	}

	function onScopeInputsChange(): void {
		clearAutoFilledCollectionSlug();
		// Keep completed NFT identity evidence while correcting scope. A pending
		// lookup must not refill the local slug after the user has changed it.
		if (openSeaSlugPending) invalidateOpenSeaResolution();
	}

	function setImageSourceFieldValue(value: string): void {
		imageSourceField = value;
		resetImageCacheEstimateState();
		if (imageSourceFieldInputElement) imageSourceFieldInputElement.value = value;
	}

	function readImageSourceFieldInputValue(): string {
		return normalizeFieldValue(imageSourceFieldInputElement?.value ?? imageSourceField);
	}

	function setAnimationSourceFieldValue(value: string): void {
		animationSourceField = value;
		if (animationSourceFieldInputElement) animationSourceFieldInputElement.value = value;
	}

	function readAnimationSourceFieldInputValue(): string {
		return normalizeFieldValue(animationSourceFieldInputElement?.value ?? animationSourceField);
	}

	function setSampleTokenIdValue(value: string): void {
		sampleTokenId = value;
		if (sampleTokenIdInputElement) sampleTokenIdInputElement.value = value;
	}

	function onCollectionSlugInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		setCollectionSlugInputValue(target.value);
	}

	function onBootstrapAddressInput(event: Event): void {
		bootstrapAddress = (event.currentTarget as HTMLInputElement).value;
		invalidateContractProbe();
	}

	function applyBootstrapNftUrl(input: HTMLInputElement, value: string): boolean {
		if (!contractAddressSafetyAcknowledged) return false;
		const nft = parseNftUrl(value);
		if (!nft) return false;
		bootstrapAddress = nft.contractAddress;
		input.value = bootstrapAddress;
		setSampleTokenIdValue(nft.tokenId);
		invalidateContractProbe();
		return true;
	}

	function onBootstrapAddressPaste(event: ClipboardEvent): void {
		const text = event.clipboardData?.getData('text/plain');
		if (text && applyBootstrapNftUrl(event.currentTarget as HTMLInputElement, text)) {
			event.preventDefault();
		}
	}

	function onBootstrapAddressChange(event: Event): void {
		const input = event.currentTarget as HTMLInputElement;
		// Typed URLs settle on change, so the first token-ID digit never ends an edit.
		applyBootstrapNftUrl(input, input.value);
	}

	function onContractAddressSafetyAcknowledgementChange(event: Event): void {
		contractAddressSafetyAcknowledged = (event.currentTarget as HTMLInputElement).checked;
		if (!contractAddressSafetyAcknowledged) invalidateContractProbe();
	}

	function onImageSourceFieldInput(event: Event): void {
		setImageSourceFieldValue((event.currentTarget as HTMLInputElement).value);
	}

	function onAnimationSourceFieldInput(event: Event): void {
		setAnimationSourceFieldValue((event.currentTarget as HTMLInputElement).value);
		selectedBootstrapPreviewSource = BOOTSTRAP_PREVIEW_SOURCE.Image;
	}

	function onSampleTokenIdInput(event: Event): void {
		setSampleTokenIdValue((event.currentTarget as HTMLInputElement).value);
		invalidateSample();
	}

	async function onProbe(): Promise<void> {
		if (!contractAddressSafetyAcknowledged || !addressCanBeProbed || !chain) return;
		clearAutoFilledCollectionSlug();
		invalidateOpenSeaResolution();
		const requestId = ++contractProbeRequestId;
		const chainRef = chain.slug;
		const address = normalizedBootstrapAddress;
		const sampleGeneration = sampleRequestId;
		const selection = { requestedTokenId: sampleTokenId, scope: currentScope() };
		probeInputsChanged = false;
		probeStatus = BOOTSTRAP_PROBE_UI_STATUS.Loading;
		probeError = null;
		try {
			const result = await probeBootstrapCollectionContract(fetch, chainRef, address,
				outputRequest(BOOTSTRAP_OPERATION.Probe, () => requestId === contractProbeRequestId));
			if (requestId !== contractProbeRequestId || chainRef !== chain?.slug) return;
			probeResult = result;
			probeAddress = result.address;
			probeStatus = BOOTSTRAP_PROBE_UI_STATUS.Ready;
		} catch (error) {
			if (requestId !== contractProbeRequestId) return;
			probeStatus = BOOTSTRAP_PROBE_UI_STATUS.Error;
			probeError =
				error instanceof BackendApiError && [400, 422].includes(error.status)
					? error.message
					: `Contract checks failed. Check RPC settings, then press ${Action.Probe}.`;
		}
		if (
			requestId === contractProbeRequestId &&
			sampleGeneration === sampleRequestId &&
			contractAddressSafetyAcknowledged
		)
			await onInspectSample(selection);
	}

	async function onInspectSample(
		selection = { requestedTokenId: sampleTokenId, scope: currentScope() }
	): Promise<void> {
		if (!contractAddressSafetyAcknowledged || !addressCanBeProbed || !chain) return;
		clearAutoFilledCollectionSlug();
		invalidateOpenSeaResolution();
		const requestId = ++sampleRequestId;
		const chainRef = chain.slug;
		const address = normalizedBootstrapAddress;
		const submittedOpenSeaSlug = bootstrapOpenSeaSlug;
		if (
			selection.requestedTokenId.trim() &&
			normalizeEvmTokenId(selection.requestedTokenId) === null
		) {
			sampleError = 'Enter a valid decimal sample token ID.';
			sampleStatus = BOOTSTRAP_PROBE_UI_STATUS.Error;
			return;
		}
		sampleStatus = BOOTSTRAP_PROBE_UI_STATUS.Loading;
		sampleError = null;
		resetImageCacheEstimateState();
		try {
			const result = await inspectBootstrapSample(fetch, chainRef, {
				address,
				requestedTokenId: selection.requestedTokenId,
				scope: selection.scope,
				discoveredTokenId: latestProbeMatchesAddress ? probeResult?.discovery.sampleTokenId : null,
				observation: latestProbeMatchesAddress ? probeResult?.observation : null
			}, outputRequest(BOOTSTRAP_OPERATION.Inspect, () => requestId === sampleRequestId, record => {
				// Selection arrives before metadata, which may be slow or unavailable.
				if (
					record.step === BOOTSTRAP_OUTPUT_STEP.Sample &&
					record.status === BOOTSTRAP_OUTPUT_STATUS.Succeeded &&
					record.tokenId &&
					!sampleTokenId.trim()
				)
					setSampleTokenIdValue(record.tokenId);
			}));
			if (
				requestId !== sampleRequestId ||
				chainRef !== chain?.slug ||
				address !== normalizedBootstrapAddress
			)
				return;
			// Keep the same field state for ordinary JSON responses.
			if (!sampleTokenId.trim() && result.sample.tokenId)
				setSampleTokenIdValue(result.sample.tokenId);
			sampleResult = result;
			sampleStatus = BOOTSTRAP_PROBE_UI_STATUS.Ready;
			await tick();
			if (
				requestId === sampleRequestId &&
				sampleTokenIdResolved &&
				sampleMatchesScope &&
				openSeaEnabled &&
				bootstrapOpenSeaSlug === submittedOpenSeaSlug
			)
				void openSeaSlugResolver?.resolveSlug();
		} catch (error) {
			if (requestId !== sampleRequestId) return;
			sampleStatus = BOOTSTRAP_PROBE_UI_STATUS.Error;
			sampleError =
				error instanceof BackendApiError && [400, 422].includes(error.status)
					? error.message
					: sampleTokenId.trim()
						? `Sample inspection failed. Press ${Action.Inspect} to retry.`
						: `Sample inspection failed. Press ${Action.Probe} to retry or enter a sample token ID.`;
		}
	}

	function onOpenSeaSlugStateChange(state: OpenSeaSlugResolverState): void {
		const newlyResolved = state.resolved && (!openSeaSlugResolved || state.slug !== bootstrapOpenSeaSlug);
		bootstrapOpenSeaSlug = state.slug;
		openSeaSlugResolved = state.resolved;
		openSeaSlugPending = state.pending;
		if (newlyResolved && !readCollectionSlugInputValue()) {
			setCollectionSlugInputValue(state.slug);
			autoFilledCollectionSlug = state.slug;
		}
	}

	function isImageSourceFieldResolved(): boolean {
		return Boolean(
			sample &&
			imageSourceField.trim() &&
			selectedMetadata.imageSourceField === imageSourceField.trim() &&
			selectedMetadata.image
		);
	}

	function isAnimationSourceFieldResolved(): boolean {
		return Boolean(
			sample &&
			animationSourceField.trim() &&
			selectedMetadata.animationSourceField === animationSourceField.trim() &&
			selectedMetadata.animationUrl
		);
	}

	function isSampleTokenIdResolved(): boolean {
		return sample?.ownership?.exists === true;
	}

	function interfaceLabel(value: boolean | null): string {
		if (value === true) return 'yes';
		if (value === false) return 'no';
		return 'unknown';
	}

	function sampleTokenPreviewCard(): ApiTokenCard | null {
		const sampleToken = sample;
		if (!sampleToken?.tokenId) return null;
		return {
			tokenId: sampleToken.tokenId,
			marketplaceBiddingSupported: true,
			name: sampleToken.name,
			image: sampleToken.image,
			animationUrl: sampleToken.animationUrl,
			traitSummary: null,
			listingPrice: null,
			listingCurrency: null,
			attributes: [],
			hasMetadata: sampleToken.metadataError === null,
			metadataUpdatedAt: null
		};
	}

	function resolveAnimationPreviewIframeSource(): TokenMediaIframeSource | null {
		const sampleToken = sample;
		if (!animationSourceFieldResolved || !sampleToken?.tokenId || !sampleToken.animationUrl) {
			return null;
		}
		return resolveTokenMediaIframeSource(
			sampleToken.animationUrl,
			null,
			tokenMediaTitle(sampleToken.tokenId)
		);
	}

	function selectBootstrapPreviewSource(source: BootstrapPreviewSource): void {
		if (source === BOOTSTRAP_PREVIEW_SOURCE.Animation && !animationPreviewAvailable) {
			return;
		}
		selectedBootstrapPreviewSource = source;
	}

	function cachedTokenPreviewCard(): ApiTokenCard | null {
		const sampleToken = sample;
		if (
			imageCacheMode === IMAGE_CACHE_MODE.Off ||
			!imageCacheEstimateReady ||
			!imageCacheEstimateResult?.sampleCachedImageDataUrl ||
			!sampleToken?.tokenId
		) {
			return null;
		}
		return {
			tokenId: sampleToken.tokenId,
			marketplaceBiddingSupported: true,
			name: sampleToken.name,
			image: imageCacheEstimateResult.sampleCachedImageDataUrl,
			animationUrl: null,
			traitSummary: null,
			listingPrice: null,
			listingCurrency: null,
			attributes: [],
			hasMetadata: sampleToken.metadataError === null,
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

	function setScopeMode(mode: BootstrapScope['mode']): void {
		if (mode === (entireContractSelected ? BOOTSTRAP_ENUMERATION_MODE.Enumerable : manualMode)) return;
		onScopeInputsChange();
		entireContractSelected = mode === BOOTSTRAP_ENUMERATION_MODE.Enumerable;
		if (!entireContractSelected) {
			manualMode =
				mode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
					? BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds
					: BOOTSTRAP_ENUMERATION_MODE.ManualRange;
		}
	}

	function onScopeModeChange(event: Event): void {
		setScopeMode((event.currentTarget as HTMLSelectElement).value as BootstrapScope['mode']);
	}

	function setManualTokenIds(value: string): void {
		if (manualTokenIds === value) return;
		onScopeInputsChange();
		manualTokenIds = value;
	}

	function setManualRangeStartTokenId(value: string): void {
		if (manualRangeStartTokenId === value) return;
		onScopeInputsChange();
		manualRangeStartTokenId = value;
	}

	function setManualRangeTotalSupply(value: string): void {
		if (manualRangeTotalSupply === value) return;
		onScopeInputsChange();
		manualRangeTotalSupply = value;
	}

	function onManualTokenIdsInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLTextAreaElement)) return;
		setManualTokenIds(target.value);
	}

	function onManualRangeStartTokenIdInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		setManualRangeStartTokenId(target.value);
	}

	function onManualRangeTotalSupplyInput(event: Event): void {
		const target = event.currentTarget;
		if (!(target instanceof HTMLInputElement)) return;
		setManualRangeTotalSupply(target.value);
	}

	function canRunImageCacheEstimate(): boolean {
		if (
			!contractAddressSafetyAcknowledged ||
			!sampleMatchesScope ||
			scopeIssue ||
			setupIssues.maxDimension ||
			!formDetailsReady ||
			imageCacheMode === IMAGE_CACHE_MODE.Off
		)
			return false;
		if (!sample?.tokenId || !sample.image) return false;
		if (!resolvedBootstrapScopeTotalSupply()) return false;
		return !imageCacheEstimatePending;
	}

	async function onEstimateImageCache(): Promise<void> {
		if (!chain || !sample || !canRunImageCacheEstimate()) return;
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
		const sampleToken = sample!;
		const totalSupply = resolvedBootstrapScopeTotalSupply();
		if (!sampleToken.tokenId || !sampleToken.image || !totalSupply) return;
		imageCacheEstimateRequestId += 1;
		const requestId = imageCacheEstimateRequestId;
		imageCacheEstimateStatus = imageCacheEstimateUiStatus.Loading;
		imageCacheEstimateResult = null;
		imageCacheEstimateError = null;
		try {
			const result = await estimateBootstrapImageCache(fetch, chain.slug, {
				sampleTokenId: sampleToken.tokenId,
				sourceImageUrl: sampleToken.image,
				sourceImageBytes: null,
				imageCacheMode,
				maxDimension
			}, outputRequest(BOOTSTRAP_OPERATION.Estimate, () => requestId === imageCacheEstimateRequestId));
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

	function resolvedBootstrapScopeTotalSupply(): string | null {
		const scope = currentScope();
		if (!scope) return null;
		if (scope.mode === BOOTSTRAP_ENUMERATION_MODE.Enumerable)
			return latestProbeMatchesAddress ? (probeResult?.totalSupply.value ?? null) : null;
		const count = bootstrapScopeTokenCount(scope);
		return count === null ? null : String(count);
	}

	function projectedMetadataSize(): string {
		const sampleBytes = sample?.tokenUriPayloadBytes;
		const count = resolvedBootstrapScopeTotalSupply();
		return !sampleMatchesScope || sampleBytes == null || count === null
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
		const count = resolvedBootstrapScopeTotalSupply();
		return sampleMatchesScope && count
			? formatByteSize(
					(BigInt(imageCacheEstimateResult.sampleCachedBytes) * BigInt(count)).toString()
				)
			: 'not available';
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

		const scope = bootstrapSetupScope(setupDraft);

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
				scope,
				imageCache: {
					selectedSource: COLLECTION_CUSTOMIZATION_SOURCE_KIND.User,
					imageCacheMode,
					maxDimension: imageCacheMode === IMAGE_CACHE_MODE.Off ? null : imageCacheMaxDimensionValue
				}
			}, outputRequest(BOOTSTRAP_OPERATION.Queue, () => true));
			await goto(runHref(result.runId));
		} catch (error) {
			submitError =
				error instanceof BackendApiError && [400, 409, 422].includes(error.status)
					? error.message
					: BOOTSTRAP_QUEUE_RESPONSE_UNAVAILABLE_MESSAGE;
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

{#snippet scopeSampleLink(label: string)}
	{#if openSeaSampleHref}
		<a href={openSeaSampleHref} target="_blank" rel="noreferrer noopener">{label} #{effectiveSampleTokenId}</a>
	{:else}{label} #{effectiveSampleTokenId}{/if}
{/snippet}

{#snippet sectionHeading(index: number)}
	{@const section = setupSections[index]}
	<div class="bootstrap-step-heading">
		<h3 id={section.id + '-heading'}>{index + 1}. {section.title} <span class="muted">{section.optional ? 'optional' : 'required'}</span></h3>
		{#if !section.optional || (!section.ready && index === 3)}
			<span class="bootstrap-step-status" class:bid-book-own-status={!section.ready} class:bootstrap-step-incomplete={!section.ready} class:bootstrap-step-complete={section.ready}>
				{section.ready ? '✓ complete' : section.optional ? 'check settings' : 'needs input'}
			</span>
		{/if}
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
	apply: (value: string) => void,
	label?: string,
	qualifier?: string
)}
	{#if contractAddressSafetyAcknowledged && value}
		<button
			type="button"
			class="action-button-neutral update-flash-cyan"
			use:updateFlash={{ key: value, playOnMount: true }}
			title={`apply "${label ?? value}"${qualifier ? ` ${qualifier}` : ''}`}
			disabled={value === current.trim()}
			onclick={() => apply(value)}
		>
			<span class="action-button-value">apply <code>"{label ?? value}"</code>{qualifier ? ` ${qualifier}` : ''}</span>
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
					<label for="bootstrap-address">{@render fieldLabel('Contract address or NFT URL', bootstrapFieldHelp.address)}</label>
					<input id="bootstrap-address" value={bootstrapAddress} class={bootstrapInputClass}
						type="text" name="address" required oninput={onBootstrapAddressInput}
						onpaste={onBootstrapAddressPaste} onchange={onBootstrapAddressChange}
						aria-invalid={Boolean(bootstrapAddress && setupIssues.address)}
						aria-describedby={(bootstrapAddress.trim() && setupIssues.address) || probeError ? 'bootstrap-address-help' : undefined} />
					<div class="bootstrap-row-actions">
						<button type="button" class="action-button-positive"
							disabled={!contractAddressSafetyAcknowledged || !addressCanBeProbed || !chain || contractProbePending}
							aria-label={Action.Probe} aria-busy={contractProbePending} onclick={() => void onProbe()}>
							{#if contractProbePending}{@render inProgressStatus('probing', 'probing contract')}{:else}{Action.Probe}{/if}
						</button>
						{#if probeInputsChanged && !latestProbeMatchesAddress && !contractProbePending && !probeError}
							<p class="bootstrap-row-note muted">Inputs changed — press {Action.Probe} again.</p>
						{/if}
						{#if (bootstrapAddress.trim() && setupIssues.address) || probeError}
							<p id="bootstrap-address-help" class="bootstrap-row-note" class:muted={!probeError} class:bootstrap-check-warning={Boolean(probeError)} role={probeError ? 'alert' : undefined}>
								{probeError ?? setupIssues.address}
							</p>
						{/if}
					</div>
				</div>
				<div class="bootstrap-form-row">
					<label for="bootstrap-sample">{@render fieldLabel('Sample token ID', bootstrapFieldHelp.sampleTokenId)}</label>
					<input id="bootstrap-sample" bind:this={sampleTokenIdInputElement} value={sampleTokenId}
						class={bootstrapInputClass} type="text" inputmode="numeric" name="sampleTokenId"
						oninput={onSampleTokenIdInput}
						aria-describedby={sampleProbeFailure ? 'bootstrap-sample-help' : undefined} />
					<div class="bootstrap-row-actions">
						<button type="button" class="action-button-positive" aria-label={Action.Inspect} aria-busy={samplePending}
							disabled={!sampleTokenId.trim() || !addressCanBeProbed || samplePending || contractProbePending} onclick={() => void onInspectSample()}>
							{#if samplePending}{@render inProgressStatus('inspecting', 'inspecting sample')}{:else}{Action.Inspect}{/if}
						</button>
						{#if sampleProbeFailure}
							<p id="bootstrap-sample-help" class="bootstrap-row-note bootstrap-check-warning" role="alert">
								{sampleProbeFailure}
							</p>
						{/if}
					</div>
				</div>
				{#if latestProbeMatchesAddress && probeResult}
					<div class="bootstrap-form-row">
						<span class="bootstrap-form-label-cell">Contract checks</span>
						<div class="bootstrap-read-value">
							{probeResult.contractName ?? 'Name unavailable'} · ERC721 {interfaceLabel(probeResult.erc721.supported)}
						</div>
					</div>
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
						<div class="bootstrap-read-value mono">{formatByteSize(sample?.tokenUriPayloadBytes)}</div>
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
			</section>

			<section class="bootstrap-form-section" id={setupSections[1].id} aria-labelledby="bootstrap-scope-heading">
				{@render sectionHeading(1)}
				<div class="bootstrap-form-row">
					<label for="bootstrap-scope-mode">{@render fieldLabel('Token scope', bootstrapFieldHelp.manualMode)}</label>
					<select id="bootstrap-scope-mode" class={bootstrapSelectClass}
						aria-describedby={[likelySharedContract ? 'bootstrap-shared-contract-help' : '', sampleScopeConflict ? 'bootstrap-scope-sample-help' : ''].filter(Boolean).join(' ') || undefined}
						value={entireContractSelected ? BOOTSTRAP_ENUMERATION_MODE.Enumerable : manualMode}
						onchange={onScopeModeChange}>
						<option value={BOOTSTRAP_ENUMERATION_MODE.ManualRange}>Token range</option>
						<option value={BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds}>Token ID list</option>
						<option value={BOOTSTRAP_ENUMERATION_MODE.Enumerable}>Entire contract</option>
					</select>
					<div class="bootstrap-row-actions">
						{#if likelySharedContract}
							{#if projectScope}
								{@render applySuggestion('token range', !entireContractSelected && manualMode === BOOTSTRAP_ENUMERATION_MODE.ManualRange ? 'token range' : '', () => setScopeMode(BOOTSTRAP_ENUMERATION_MODE.ManualRange))}
							{/if}
							<p id="bootstrap-shared-contract-help" class="bootstrap-row-note bootstrap-check-warning">
								{#if projectScope}
									{projectScope.projectName ? `${projectScope.projectName} · ` : ''}project #{projectScope.projectId}.<br />
								{:else}Likely shared contract. Specify this collection's Token range or Token ID list manually.{/if}
								{#if probeResult?.totalSupply.value != null}{probeResult.totalSupply.value} tokens across all projects on the contract.
								{:else}Contract token count unavailable.{/if}
							</p>
						{:else if latestProbeMatchesAddress && probeResult?.enumerable.supported === true}
							{@render applySuggestion('entire contract', entireContractSelected ? 'entire contract' : '', () => setScopeMode(BOOTSTRAP_ENUMERATION_MODE.Enumerable))}
							{#if !entireContractSelected}
								<p class="bootstrap-row-note bootstrap-check-warning">
									{#if probeResult.totalSupply.value != null}{probeResult.totalSupply.value} tokens on this contract.
									{:else}Contract token count unavailable.{/if}
								</p>
							{/if}
						{/if}
						{#if entireContractSelected && !likelySharedContract}
							<p class="bootstrap-row-note muted">
								Includes all tokens on this contract.
								{#if latestProbeMatchesAddress && probeResult?.totalSupply.value != null}
									<span class="bootstrap-check-warning">{probeResult.totalSupply.value} tokens in total.</span>
								{:else}<span class="bootstrap-check-warning">Contract token count unavailable.</span>{/if}
							</p>
						{/if}
						{#if entireContractSelected && (!latestProbeMatchesAddress || probeResult?.enumerable.supported !== true)}
							<p class="bootstrap-row-note bootstrap-check-warning">
								ERC721Enumerable not confirmed. Use Token range or Token ID list if enumeration is unavailable.
							</p>
						{/if}
						{#if sampleScopeConflict}
							<p id="bootstrap-scope-sample-help" class="bootstrap-row-note bootstrap-check-warning">
								{#if scopeIssue}Complete this collection's token scope, then check that {@render scopeSampleLink('sample')} belongs to it.
								{:else}{@render scopeSampleLink('Sample')} is outside this scope. Correct the range or token list, or inspect a token inside it.{/if}
								{#if openSeaSlugResolved}Until then, its resolved OpenSea slug will be kept here but skipped when queueing.
								{/if}
							</p>
						{/if}
					</div>
				</div>
				{#if !entireContractSelected && manualMode === BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds}
					<div class="bootstrap-form-row bootstrap-form-row-textarea">
						<label for="bootstrap-token-ids">{@render fieldLabel('Token IDs', bootstrapFieldHelp.tokenIds)}</label>
						<textarea id="bootstrap-token-ids" value={manualTokenIds} class={bootstrapTextareaClass}
							rows="3" required oninput={onManualTokenIdsInput}
							aria-invalid={Boolean(manualTokenIds && setupIssues.tokenIds)} aria-describedby={manualTokenIds.trim() ? 'bootstrap-token-ids-help' : undefined}></textarea>
						<div class="bootstrap-row-actions">
							{#if manualTokenIds.trim()}
								<p id="bootstrap-token-ids-help" class="bootstrap-row-note muted">
									{setupIssues.tokenIds ?? `${resolvedBootstrapScopeTotalSupply()} token IDs selected.`}
								</p>
							{/if}
						</div>
					</div>
				{:else if !entireContractSelected}
					<div class="bootstrap-form-row">
						<label for="bootstrap-range-start">{@render fieldLabel('First token ID', bootstrapFieldHelp.startTokenId)}</label>
						<input id="bootstrap-range-start" value={manualRangeStartTokenId} class={bootstrapInputClass}
							type="text" inputmode="numeric" required oninput={onManualRangeStartTokenIdInput}
							aria-invalid={Boolean(manualRangeStartTokenId.trim() && setupIssues.startTokenId)}
							aria-describedby={manualRangeStartTokenId.trim() && setupIssues.startTokenId ? 'bootstrap-range-start-help' : undefined} />
						<div class="bootstrap-row-actions">
							{@render applySuggestion(rangeSuggestions.startTokenId, manualRangeStartTokenId, setManualRangeStartTokenId)}
							{#if contractReady && !rangeSuggestions.startTokenIdConfirmed}
								<div class="bootstrap-row-note">
									{#each BOOTSTRAP_CONVENTIONAL_TOKEN_IDS as tokenId}
										<a href={openseaItemHref({ chainSlug: chain?.slug ?? null, collectionAddress: normalizedBootstrapAddress, tokenId })} target="_blank" rel="noreferrer noopener">[token #{tokenId}]</a>{' '}
									{/each}
								</div>
							{/if}
							{#if manualRangeStartTokenId.trim() && setupIssues.startTokenId}
								<p id="bootstrap-range-start-help" class="bootstrap-row-note muted">{setupIssues.startTokenId}</p>
							{/if}
						</div>
					</div>
					<div class="bootstrap-form-row">
						<label for="bootstrap-range-count">{@render fieldLabel('Token count', bootstrapFieldHelp.manualRangeTotalSupply)}</label>
						<input id="bootstrap-range-count" value={manualRangeTotalSupply} class={bootstrapInputClass}
							type="text" inputmode="numeric" required oninput={onManualRangeTotalSupplyInput}
							aria-invalid={Boolean(manualRangeTotalSupply && setupIssues.totalSupply)}
							aria-describedby={manualRangeTotalSupply.trim() && (setupIssues.totalSupply || !scopeIssue) ? 'bootstrap-range-help' : undefined} />
						<div class="bootstrap-row-actions">
							{@render applySuggestion(rangeSuggestions.tokenCount?.toString(), manualRangeTotalSupply, setManualRangeTotalSupply, undefined, rangeSuggestions.maxTokenCount !== null ? 'minted' : undefined)}
							{#if rangeSuggestions.maxTokenCount !== null}
								{@render applySuggestion(String(rangeSuggestions.maxTokenCount), manualRangeTotalSupply, setManualRangeTotalSupply, undefined, 'maximum')}
								<p class="bootstrap-row-note bootstrap-check-warning">The configured maximum includes unminted token IDs.</p>
							{/if}
							{#if manualRangeTotalSupply.trim() && (setupIssues.totalSupply || !scopeIssue)}
								<p id="bootstrap-range-help" class="bootstrap-row-note muted">
									{#if setupIssues.totalSupply}{setupIssues.totalSupply}
									{:else if !scopeIssue}Specified token IDs range: {manualRangeStartTokenId.trim()}–{BigInt(manualRangeStartTokenId.trim()) + BigInt(manualRangeTotalSupply.trim()) - 1n}{/if}
								</p>
							{/if}
						</div>
					</div>
				{/if}
				{#if latestProbeMatchesAddress && probeResult?.totalSupply.value}
					<div class="bootstrap-form-row">
						{@render fieldLabel('Contract total supply', bootstrapFieldHelp.contractTotalSupply)}
						<div class="bootstrap-read-value mono">{probeResult.totalSupply.value}</div>
					</div>
				{/if}
			</section>

			<section class="bootstrap-form-section" id={setupSections[2].id} aria-labelledby="bootstrap-details-heading">
				{@render sectionHeading(2)}
				<div class="bootstrap-form-row">
					<label for="bootstrap-slug">{@render fieldLabel('Collection slug', bootstrapFieldHelp.slug)}</label>
					<input id="bootstrap-slug" bind:this={collectionSlugInputElement} value={bootstrapSlug}
						class={bootstrapInputClass} type="text" name="slug" required oninput={onCollectionSlugInput}
						aria-invalid={Boolean(bootstrapSlug && setupIssues.slug)}
						aria-describedby={bootstrapSlug.trim() && setupIssues.slug ? 'bootstrap-slug-help' : undefined} />
					<div class="bootstrap-row-actions">
						{@render applySuggestion(contractSlugSuggestion, bootstrapSlug, setCollectionSlugInputValue)}
						{#if openSeaSlugResolved && bootstrapOpenSeaSlug !== contractSlugSuggestion}
							{@render applySuggestion(bootstrapOpenSeaSlug, bootstrapSlug, setCollectionSlugInputValue)}
						{/if}
						{#if bootstrapSlug.trim() && setupIssues.slug}<p id="bootstrap-slug-help" class="bootstrap-row-note muted">{setupIssues.slug}</p>{/if}
					</div>
				</div>
				<div class="bootstrap-form-row">
					<label for="bootstrap-image-field">{@render fieldLabel('Image source field', bootstrapFieldHelp.imageSourceField)}</label>
					<input id="bootstrap-image-field" bind:this={imageSourceFieldInputElement} value={imageSourceField}
						class={bootstrapInputClass} type="text" name="imageSourceField" required oninput={onImageSourceFieldInput} />
					<div class="bootstrap-row-actions">
						{@render applySuggestion(metadataSuggestions.imageSourceField, imageSourceField, setImageSourceFieldValue)}
					</div>
				</div>
				<div class="bootstrap-form-row">
					<label for="bootstrap-animation-field">{@render fieldLabel('Animation source field (optional)', bootstrapFieldHelp.animationSourceField)}</label>
					<input id="bootstrap-animation-field" bind:this={animationSourceFieldInputElement} value={animationSourceField}
						class={bootstrapInputClass} type="text" name="animationSourceField" oninput={onAnimationSourceFieldInput} />
					<div class="bootstrap-row-actions">
						{@render applySuggestion(metadataSuggestions.animationSourceField, animationSourceField, setAnimationSourceFieldValue)}
					</div>
				</div>
				{#if formDetailsReady && sampleTokenCard}
					<div class="bootstrap-form-row">
						<span class="bootstrap-form-label-cell">Sample preview</span>
						<div class="bootstrap-read-value">Token #{sampleTokenCard.tokenId}</div>
					</div>
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
										hideScrollbars title={`${tokenMediaTitle(sampleTokenCard.tokenId)} animation preview`} />
								</div>
							{:else}
								<div class="bootstrap-probe-token-card" data-testid={TEST_IDS.BootstrapProbeTokenCard}>
									<TokenCardTile {chain} collection={null} token={sampleTokenCard} href="#"
										selectedMediaMode={COLLECTION_MEDIA_MODES.Snapshot} availableMediaModes={bootstrapPreviewMediaModes}
										{tokenPreview} showMeta={false} />
								</div>
							{/if}
						</aside>
					</div>
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
					<div class="bootstrap-row-actions">
						{@render applySuggestion(imageCacheSuggestion?.config.imageCacheMode, imageCacheMode, (value) => { imageCacheMode = parseImageCacheMode(value); resetImageCacheEstimateState(); }, imageCacheSuggestion ? imageCacheModeLabel(imageCacheSuggestion.config.imageCacheMode) : undefined)}
					</div>
				</div>
				{#if imageCacheMode !== IMAGE_CACHE_MODE.Off}
					<div class="bootstrap-form-row">
						<label for="bootstrap-cache-dimension">{@render fieldLabel('Max dimension (px)', bootstrapFieldHelp.imageMaxDimension)}</label>
						<input id="bootstrap-cache-dimension" value={imageCacheMaxDimensionDraft} class={bootstrapInputClass}
							type="text" inputmode="numeric" oninput={onImageCacheMaxDimensionInput}
							onkeydown={onImageCacheMaxDimensionKeydown} aria-invalid={Boolean(setupIssues.maxDimension)}
							aria-describedby={setupIssues.maxDimension || (!imageCacheEstimateCanRun && !imageCacheEstimatePending && !imageCacheEstimateReady) ? 'bootstrap-cache-help' : undefined} />
						<div class="bootstrap-row-actions">
							{@render applySuggestion(imageCacheSuggestion ? String(imageCacheSuggestion.config.maxDimension ?? 'original') : null, imageCacheMaxDimensionDraft || 'original', (value) => { imageCacheMaxDimensionDraft = value === 'original' ? '' : value; resetImageCacheEstimateState(); })}
							<button type="button" class="action-button-positive" disabled={!imageCacheEstimateCanRun}
								aria-label="estimate" aria-busy={imageCacheEstimatePending} onclick={() => void onEstimateImageCache()}>
								{#if imageCacheEstimatePending}{@render inProgressStatus('estimating', 'estimating image cache size')}{:else}estimate{/if}
							</button>
							{#if setupIssues.maxDimension || (!imageCacheEstimateCanRun && !imageCacheEstimatePending && !imageCacheEstimateReady)}
								<p id="bootstrap-cache-help" class="bootstrap-row-note muted">
									{setupIssues.maxDimension ?? (scopeIssue ? 'Define the token scope to estimate.' : 'Inspect a token in this scope and select its image field to estimate.')}
								</p>
							{/if}
							{#if imageCacheEstimateError}
								<p class="bootstrap-row-note bootstrap-check-warning" role="alert">{imageCacheEstimateError}</p>
							{/if}
						</div>
					</div>
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
					</div>
					<div class="bootstrap-form-row">
						<span class="bootstrap-form-label-cell">Estimated cache (selected scope)</span>
						<div class="bootstrap-read-value mono"><span class="bootstrap-check-warning">{imageCacheProjectedOutputValue()}</span> · {resolvedBootstrapScopeTotalSupply()} tokens</div>
					</div>
					{#if cachedTokenCard}
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
						bind:this={openSeaSlugResolver} sampleTokenId={effectiveSampleTokenId} initialSlug="" inputId="bootstrap-opensea-slug"
						inputClass={bootstrapInputClass} gridLayout openSeaEnabled={openSeaEnabled && contractAddressSafetyAcknowledged} onStateChange={onOpenSeaSlugStateChange}
						inputDisabled={!contractAddressSafetyAcknowledged}
						resolvedScopeHref={!sampleMatchesScope ? '#bootstrap-scope' : null}
						onOutput={recordOutput}
						disabledReason={!contractAddressSafetyAcknowledged ? null : openSeaDisabledReason ? `${openSeaDisabledReason}. ${openSeaSetupMessage}` : openSeaSetupMessage} />
					{#if openSeaEnabled && !effectiveSampleTokenId}
						<p class="bootstrap-row-note muted">Inspect a sample token to resolve.</p>
					{/if}
					{#if contractAddressSafetyAcknowledged && (openSeaCollectionHref || openSeaSampleHref)}
						<div class="bootstrap-row-note">
							{#if openSeaCollectionHref}<div><a href={openSeaCollectionHref} target="_blank" rel="noreferrer noopener">[collection page]</a></div>{/if}
							{#if openSeaSampleHref}<div><a href={openSeaSampleHref} target="_blank" rel="noreferrer noopener">[sample token #{effectiveSampleTokenId}]</a></div>{/if}
						</div>
					{/if}
				</div>
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
	<BootstrapOperationLog log={operationLog} />
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
