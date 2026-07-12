import {
	COLLECTION_MEDIA_SOURCE,
	TRADING_BIDDING_BID_BOOK_PRICE_KIND,
	TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND,
	type CollectionStandard,
	type CollectionBiddingBidScopeFilter,
	type CollectionBiddingTraitFilterJoinMode,
	type CollectionMediaSource,
	type CollectionStatus,
	type OpenSeaCollectionStatus,
	type OpenSeaStreamIngestionStatus,
	type TradingBiddingBidBookSource,
	type TradingBiddingBidBookOwnJobPhase,
	type TradingBiddingJobRuntimeBidPosition,
	type TradingBiddingJobRuntimeConstraint,
	type TradingBotLifecycleStatus,
	type TradingBiddingJobPricingSource,
	type TradingBiddingTierSelectionMode
} from '@artgod/shared/types';
import type { EvmProxyConfidence, EvmProxyKind } from '@artgod/shared/evm/proxy-detection';
import type { ImageCacheMode } from '@artgod/shared/media/token-image-cache';
import type {
	BootstrapFlowStepKey,
	BootstrapFlowStepState,
	BootstrapRunStatus,
	BootstrapStepAction,
	BootstrapStepKey,
	BootstrapStepStatus,
	BootstrapTaskCounts,
	BootstrapTaskStatus
} from '@artgod/shared/bootstrap/pipeline';
import type { BootstrapOpenSeaSlugProbeStatus } from '@artgod/shared/bootstrap/opensea-slug-probe';

export type ApiChain = {
	id: number;
	type: string;
	publicChainId: number;
	slug: string;
	name: string;
	averageBlockTimeSeconds?: number;
	genesisBlockNumber?: number | null;
	genesisBlockTimestamp?: number | null;
};

export type ApiCollection = {
	chainId: number;
	collectionId: number;
	slug: string;
	address: string;
	standard: CollectionStandard;
	status: CollectionStatus;
	openseaSlug?: string | null;
	openseaStatus?: OpenSeaCollectionStatus | null;
	openseaReadyAt?: string | null;
	openseaStreamIngestionStatus?: OpenSeaStreamIngestionStatus | null;
	deploymentBlock: number | null;
	bootstrapAnchorBlock: number | null;
	createdAt: string;
	updatedAt: string;
	tokenScope?: ApiCollectionTokenScopeSummary;
	extensions?: ApiCollectionExtensionSummary[];
	activityEventFeeds?: ApiActivityExtensionEventFeed[];
};

export type ApiCollectionTokenScopeSummary = {
	label: string;
	items: Array<{
		label: string;
		value: string;
	}>;
};

// Enabled collection extension summary exposed to frontend extension registries.
export type ApiCollectionExtensionSummary = {
	key: string;
};

export type ApiCollectionMediaMode = {
	key: string;
	label: string;
};

export type ApiCollectionMediaState = {
	selectedMode: string;
	defaultMode: string;
	availableModes: ApiCollectionMediaMode[];
};

export type ApiActivityEventMedia = {
	image: string | null;
	animationUrl: string | null;
	htmlContent?: string | null;
	mediaRef: string;
	renderModes?: ApiCollectionMediaMode[];
};

export type OwnerRefResolutionApiResponse = {
	input: string;
	resolvedAddress: string;
};

export type ApiCollectionCustomizationSource = 'user' | 'extension';
export type ApiCollectionMediaSource = CollectionMediaSource;

export type ApiImageCacheMode = ImageCacheMode;
export type ApiBiddingJobStatus = 'enabled' | 'paused' | 'archived';

export type ApiTraitFilterDisplayKind = 'set' | 'range';

export type ApiCollectionHolder = {
	owner: string;
	tokenCount: string;
	heldPercent: number | null;
};

export type ApiActivityFeedFilterKind = 'sales' | 'listings' | 'transfers';

export type ApiActivityExtensionEventRef = {
	extensionKey: string;
	eventKey: string;
};

export type ApiActivityExtensionEventFeed = ApiActivityExtensionEventRef & {
	label: string;
	filters?: {
		tokenId?: { label: string };
		maker?: { label: string };
		contentHash?: { label: string };
		eventGroup?: {
			label: string;
			options: { key: string; label: string }[];
		};
	};
};

export type ApiActivityKind =
	| 'transfer'
	| 'sale'
	| 'listing_created'
	| 'listing_cancelled'
	| 'bid_created'
	| 'bid_cancelled'
	| 'custom';

export type ApiActivityFeedItem = {
	id: number;
	scopeKind: 'token' | 'collection' | 'attribute';
	kind: ApiActivityKind;
	contract: string;
	tokenId: string | null;
	occurredAt: number;
	sourceKind: 'onchain' | 'offchain' | 'extension';
	sourceName: string;
	orderId: string | null;
	blockNumber: number | null;
	txHash: string | null;
	logIndex: number | null;
	from: string | null;
	to: string | null;
	maker: string | null;
	taker: string | null;
	side: 'buy' | 'sell' | null;
	amount: string | null;
	price: string | null;
	currency: string | null;
	payload: Record<string, unknown> | null;
	isCollapsed: boolean;
	collapsedEventCount: number | null;
	collapsedWindowStartUtc: number | null;
	collapsedWindowEndUtc: number | null;
};

export type ApiTokenPresentationSummary = {
	tokenId: string;
	marketplaceBiddingSupported: boolean;
	name: string | null;
	image: string | null;
	traitSummary: string | null;
	hasMetadata: boolean;
	metadataUpdatedAt: string | null;
};

export type ApiActivitiesPage = {
	items: ApiActivityFeedItem[];
	prevCursor: string | null;
	nextCursor: string | null;
	limit: number;
	totalItems: number;
	rangeStart: number;
	rangeEnd: number;
	currentPage: number;
	totalPages: number;
};

export type ApiCollectionHoldersPage = {
	items: ApiCollectionHolder[];
	nextCursor: string | null;
	limit: number;
	totalItems: number;
	rangeStart: number;
	rangeEnd: number;
	currentPage: number;
	totalPages: number;
};

export type ApiCollectionsPage = {
	items: ApiCollection[];
	nextCursor: string | null;
	limit: number;
};

export type ApiBootstrapProbeInterfaceCheck = {
	supported: boolean | null;
	error: string | null;
};

export type ApiBootstrapProbeTotalSupply = {
	status: 'available' | 'unavailable';
	value: string | null;
	safeIntegerValue: number | null;
	bootstrapRangeValue: number | null;
	error: string | null;
};

export type ApiBootstrapProbeTokenCandidate = {
	tokenId: string;
	exists: boolean | null;
	source: 'token_uri' | 'owner_of' | null;
	error: string | null;
};

export type ApiBootstrapProbeFirstToken = {
	tokenId: string | null;
	source: 'token_by_index' | 'candidate_token_uri' | 'candidate_owner_of' | null;
	tokenUri: string | null;
	tokenUriPayloadBytes: number | null;
	tokenUriPayloadTruncated: boolean;
	tokenUriPayloadError: string | null;
	name: string | null;
	imageSourceField: string | null;
	image: string | null;
	imageBytes: number | null;
	imageBytesSource: 'content_length' | 'download' | 'data_uri' | null;
	imageContentType: string | null;
	imageBytesError: string | null;
	imageWidth: number | null;
	imageHeight: number | null;
	animationSourceField: string | null;
	animationUrl: string | null;
	metadataError: string | null;
	candidates: ApiBootstrapProbeTokenCandidate[];
};

export type ApiBootstrapProbeStorageEstimate = {
	sampleTokenId: string;
	samplePayloadBytes: number;
	projectedBytes: string;
	totalSupply: string;
} | null;

export type ApiBootstrapProbeImageStorageEstimate = {
	sampleTokenId: string;
	sampleImageBytes: number;
	projectedBytes: string;
	totalSupply: string;
	contentType: string | null;
} | null;

export type BootstrapContractProbeApiResponse = {
	chain: ApiChain;
	address: string;
	standard: 'erc721';
	proxy: {
		kind: EvmProxyKind;
		confidence: EvmProxyConfidence;
		implementationAddress: string;
		beaconAddress: string | null;
	} | null;
	contractName: string | null;
	erc721: ApiBootstrapProbeInterfaceCheck;
	enumerable: ApiBootstrapProbeInterfaceCheck;
	totalSupply: ApiBootstrapProbeTotalSupply;
	firstToken: ApiBootstrapProbeFirstToken;
	storageEstimate: ApiBootstrapProbeStorageEstimate;
	imageStorageEstimate: ApiBootstrapProbeImageStorageEstimate;
	suggestedInput: {
		supportsEnumerable: boolean;
		manualInput: {
			mode: 'manual_range';
			startTokenId: string;
			totalSupply: number;
		} | null;
		ready: boolean;
		warnings: string[];
	};
	imageCacheSuggestion: {
		selectedSource: ApiCollectionCustomizationSource;
		extensionKey: string | null;
		config: ApiImageCachePolicyConfig;
	};
};

export type BootstrapImageCacheEstimateApiResponse = {
	chain: ApiChain;
	sampleTokenId: string;
	imageCacheMode: ApiImageCacheMode;
	maxDimension: number | null;
	sampleSourceBytes: number | null;
	sampleCachedBytes: number;
	projectedCachedBytes: string;
	totalSupply: string;
	contentType: string | null;
	sampleCachedImageDataUrl: string | null;
	sourceWidth: number | null;
	sourceHeight: number | null;
	width: number | null;
	height: number | null;
};

export type ApiTokenAttribute = {
	key: string;
	value: string;
};

export type ApiTraitRangeFilter = {
	key: string;
	fromValue: string | null;
	toValue: string | null;
};

export type ApiTradingTraitCriterion = {
	type: string;
	value: string;
};

export type ApiBiddingPriceTierFloorConfig =
	| {
			kind: 'fixed';
			valueEth: string;
	  }
	| {
			kind: 'parent_delta';
			deltaKind: 'absolute' | 'percent';
			deltaEth?: string;
			percent?: string;
	  };

export type ApiBiddingPriceTierCeilingConfig =
	| {
			kind: 'fixed';
			valueEth: string;
	  }
	| {
			kind: 'floor_delta' | 'parent_delta';
			deltaKind: 'absolute' | 'percent';
			deltaEth?: string;
			percent?: string;
	  };

export type ApiBiddingPriceTier = {
	tierId: string;
	name: string;
	status: ApiBiddingJobStatus;
	sortOrder: number;
	parentTierId: string | null;
	floorConfig: ApiBiddingPriceTierFloorConfig;
	ceilingConfig: ApiBiddingPriceTierCeilingConfig;
	deltaEth: string;
	resolvedFloorEth: string | null;
	resolvedCeilingEth: string | null;
	resolvedAt: string | null;
	lastError: string | null;
	revision: number;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
};

export type ApiBiddingCollectionSettings = {
	tierSelectionMode: TradingBiddingTierSelectionMode;
	defaultDeltaEth: string;
	updatedAt: string | null;
};

export type ApiBiddingJobPricingSource = TradingBiddingJobPricingSource;

export type ApiTokenCard = {
	tokenId: string;
	marketplaceBiddingSupported: boolean;
	name: string | null;
	image: string | null;
	animationUrl: string | null;
	traitSummary: string | null;
	listingPrice: string | null;
	listingCurrency: string | null;
	attributes: ApiTokenAttribute[];
	hasMetadata: boolean;
	metadataUpdatedAt: string | null;
};

export type ApiTokenDetailTrait = {
	key: string;
	value: string;
	tokenCount: number | null;
	rarityPercent: number | null;
	marketplaceBiddingSupported: boolean;
};

export type ApiTokenDetail = {
	tokenId: string;
	marketplaceBiddingSupported: boolean;
	name: string | null;
	image: string | null;
	animationUrl: string | null;
	listingPrice: string | null;
	listingCurrency: string | null;
	currentHolder: string | null;
	attributes: ApiTokenDetailTrait[];
	hasMetadata: boolean;
	metadataUpdatedAt: string | null;
};

export type ApiTokenPreview = Pick<ApiTokenDetail, 'tokenId' | 'image' | 'animationUrl'>;

export type ApiTokensPage = {
	items: ApiTokenCard[];
	prevCursor: string | null;
	nextCursor: string | null;
	limit: number;
	totalItems: number;
	marketplaceBiddingSupportedTotalItems: number;
	rangeStart: number;
	rangeEnd: number;
	currentPage: number;
	totalPages: number;
};

export type ApiTraitFacet = {
	key: string;
	displayKind: ApiTraitFilterDisplayKind;
	minValue: string | null;
	maxValue: string | null;
	values: Array<{
		value: string;
		tokenCount: number;
		marketplaceBiddingSupported: boolean;
	}>;
};

export type ApiTraitCatalogFacet = {
	key: string;
	values: Array<{
		value: string;
		tokenCount: number;
	}>;
};

export type ApiTraitCatalog = {
	scope: ApiTokenAttribute[];
	facets: ApiTraitCatalogFacet[];
};

export type ApiTraitFilterPresentationConfig = {
	rangeKeys: string[];
};

export type ApiTraitFilterPresentationFeatureState = {
	selectedSource: ApiCollectionCustomizationSource;
	userConfig: ApiTraitFilterPresentationConfig;
	extensionConfig: ApiTraitFilterPresentationConfig | null;
	effectiveConfig: ApiTraitFilterPresentationConfig;
	availableTraitKeys: string[];
};

export type ApiTraitSummaryTemplateConfig = {
	template: string;
};

export type ApiTraitSummaryTemplateFeatureState = {
	selectedSource: ApiCollectionCustomizationSource;
	userConfig: ApiTraitSummaryTemplateConfig;
	extensionConfig: ApiTraitSummaryTemplateConfig | null;
	effectiveConfig: ApiTraitSummaryTemplateConfig;
};

export type ApiImageCachePolicyConfig = {
	imageCacheMode: ApiImageCacheMode;
	maxDimension: number | null;
};

export type ApiImageCachePolicyFeatureState = {
	selectedSource: ApiCollectionCustomizationSource;
	userConfig: ApiImageCachePolicyConfig;
	extensionConfig: ApiImageCachePolicyConfig | null;
	effectiveConfig: ApiImageCachePolicyConfig;
};

export type ApiMediaPurposePolicyConfig = {
	tokenCard: typeof COLLECTION_MEDIA_SOURCE.Image;
	fullscreenPreview: ApiCollectionMediaSource;
	tokenDetail: ApiCollectionMediaSource;
};

export type ApiMediaPurposePolicyFeatureState = {
	selectedSource: ApiCollectionCustomizationSource;
	userConfig: ApiMediaPurposePolicyConfig;
	extensionConfig: ApiMediaPurposePolicyConfig | null;
	effectiveConfig: ApiMediaPurposePolicyConfig;
};

export type CollectionsApiResponse = {
	chain: ApiChain;
	filters: {
		status: ApiCollection['status'] | null;
	};
	page: ApiCollectionsPage;
};

export type CollectionPurgeApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	deletedRows: Array<{
		table: string;
		rowCount: number;
	}>;
	totalDeletedRows: number;
};

export type OpenSeaCollectionSyncApiResponse = {
	chain: ApiChain;
	collection: {
		chainId: number;
		collectionId: number;
		slug: string;
		address: string;
		status: CollectionStatus;
		openseaSlug: string | null;
		openseaStatus: OpenSeaCollectionStatus | null;
		openseaLastError: string | null;
	};
	openseaStatus: OpenSeaCollectionStatus;
};

export type OpenSeaStreamIngestionApiResponse = {
	chain: ApiChain;
	collection: {
		chainId: number;
		collectionId: number;
		slug: string;
		status: CollectionStatus;
		openseaSlug: string | null;
		openseaStreamIngestionStatus: OpenSeaStreamIngestionStatus;
	};
	openseaStreamIngestionStatus: OpenSeaStreamIngestionStatus;
};

export type CollectionDetailApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	media: ApiCollectionMediaState;
	traits: {
		selected: ApiTokenAttribute[];
		selectedRanges: ApiTraitRangeFilter[];
		facets: ApiTraitFacet[];
	};
	tokens: ApiTokensPage;
};

export type CollectionTraitCatalogApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	traitCatalog: ApiTraitCatalog;
};

export type CollectionHoldersApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	holders: ApiCollectionHoldersPage;
};

export type CollectionActivitiesApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	media: ApiCollectionMediaState;
	traits: {
		selected: ApiTokenAttribute[];
		selectedRanges: ApiTraitRangeFilter[];
		facets: ApiTraitFacet[];
	};
	activities: ApiActivitiesPage;
	included: {
		tokensById: Record<string, ApiTokenPresentationSummary>;
		eventMediaByActivityId: Record<string, ApiActivityEventMedia>;
		hasTraitSummaryTemplate: boolean;
	};
};

export type CollectionCustomizationApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	customization: {
		traitFilterPresentation: ApiTraitFilterPresentationFeatureState;
		tokenCardTraitSummaryTemplate: ApiTraitSummaryTemplateFeatureState;
		activityRowTraitSummaryTemplate: ApiTraitSummaryTemplateFeatureState;
		imageCachePolicy: ApiImageCachePolicyFeatureState;
		mediaPurposePolicy: ApiMediaPurposePolicyFeatureState;
	};
};

export type ApiBiddingJobTarget =
	| {
			type: 'token';
			tokenId: string;
	  }
	| {
			type: 'collection';
			quantity: number;
			targetTraits: ApiTradingTraitCriterion[];
	  }
	| {
			type: 'competitiveTrait';
			quantity: number;
			targetTraits: ApiTradingTraitCriterion[];
			competitorTraits: ApiTradingTraitCriterion[];
	  };

export type ApiBiddingJobRuntimeState = {
	currentPriceEth: string | null;
	activeOrderId: string | null;
	activeProtocolAddress: string | null;
	activeOrderPlacedAt: string | null;
	activeOrderVerifiedAt: string | null;
	activeExpirationTimeMs: number | null;
	bidPosition: TradingBiddingJobRuntimeBidPosition | null;
	bidConstraints: TradingBiddingJobRuntimeConstraint[];
	competitorPriceEth: string | null;
	lastRunAt: string | null;
	lastError: string | null;
	updatedAt: string;
};

export type ApiBiddingJob = {
	jobId: string;
	status: ApiBiddingJobStatus;
	revision: number;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
	target: ApiBiddingJobTarget;
	config: {
		floorEth: string;
		ceilingEth: string;
		deltaEth: string;
		pricingSource: ApiBiddingJobPricingSource | null;
	};
	runtime: ApiBiddingJobRuntimeState | null;
};

export type ApiBiddingBidBookSource = TradingBiddingBidBookSource;
export type ApiBiddingBidScopeKind = 'collection' | 'trait' | 'token' | 'token_set' | 'unknown';
export type ApiCollectionBiddingBidScopeFilter = CollectionBiddingBidScopeFilter;
export type ApiCollectionBiddingTraitFilterJoinMode = CollectionBiddingTraitFilterJoinMode;
export type ApiBiddingBidBookPrice =
	| {
			kind: typeof TRADING_BIDDING_BID_BOOK_PRICE_KIND.Exact;
			wei: string;
			eth: string;
	  }
	| {
			kind: typeof TRADING_BIDDING_BID_BOOK_PRICE_KIND.Range;
			floorWei: string;
			floorEth: string;
			ceilingWei: string;
			ceilingEth: string;
	  };
export type ApiBiddingBidBookBidLimits = {
	floorWei: string;
	floorEth: string;
	ceilingWei: string;
	ceilingEth: string;
};
export type ApiBiddingBidBookRowMaterialization =
	| {
			kind: typeof TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.MarketBid;
			jobId: null;
			status: null;
			phase: null;
	  }
	| {
			kind: typeof TRADING_BIDDING_BID_BOOK_ROW_MATERIALIZATION_KIND.OwnJobIntent;
			jobId: string;
			status: ApiBiddingJobStatus;
			phase: TradingBiddingBidBookOwnJobPhase;
	  };
export type ApiBiddingBidBookOwnPosition = 'winning' | 'draw' | 'losing';
export type ApiBiddingBidBookOwnConstraint = 'ceiling' | 'floor';
export type ApiBiddingBidBookOwnStatus = {
	position: ApiBiddingBidBookOwnPosition;
	constraints: ApiBiddingBidBookOwnConstraint[];
	job: {
		jobId: string;
		revision: number;
		status: ApiBiddingJobStatus;
	} | null;
};

export type ApiBiddingBidBookRow = {
	orderId: string;
	source: ApiBiddingBidBookSource;
	materialization: ApiBiddingBidBookRowMaterialization;
	scope: {
		kind: ApiBiddingBidScopeKind;
		label: string;
		tokenId: string | null;
		traits: ApiTradingTraitCriterion[];
	};
	maker: {
		address: string;
		label: string;
		isOwn: boolean;
	};
	price: ApiBiddingBidBookPrice;
	bidLimits: ApiBiddingBidBookBidLimits | null;
	quantity: string;
	currencyAddress: string | null;
	currencySymbol: string | null;
	protocolAddress: string | null;
	validUntil: number | null;
	placedAt: string | null;
	snapshotRefreshedAtMs: number | null;
	seenAt: string | null;
	ownStatus: ApiBiddingBidBookOwnStatus | null;
};

export type ApiBiddingBidBook = {
	state: {
		source: ApiBiddingBidBookSource;
		updatedAt: string | null;
		snapshotRefreshedAtMs: number | null;
		projectedAt: string | null;
		rowCount: number;
		durationMs: number | null;
		lastError: string | null;
	};
	biddingBotStatus: TradingBotLifecycleStatus;
	ownMakerAddress: string | null;
	bids: ApiBiddingBidBookRow[];
};

export type ApiBiddingTokenOfferCard = ApiTokenCard & {
	offers: ApiBiddingBidBookRow[];
};

export type ApiBiddingTokenOfferCardsPage = {
	items: ApiBiddingTokenOfferCard[];
	prevCursor: string | null;
	nextCursor: string | null;
	limit: number;
	totalItems: number;
	marketplaceBiddingSupportedTotalItems: number;
	totalOffers: number;
	rangeStart: number;
	rangeEnd: number;
	currentPage: number;
	totalPages: number;
};

export type CollectionBiddingPriceTiersApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	settings: ApiBiddingCollectionSettings;
	tiers: ApiBiddingPriceTier[];
};

export type CollectionBiddingSettingsMutationApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	settings: ApiBiddingCollectionSettings;
};

export type CollectionBiddingPriceTierMutationApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	tier: ApiBiddingPriceTier;
	tiers: ApiBiddingPriceTier[];
};

export type ApiBiddingPriceTierReapplyPricePreview = {
	floorEth: string;
	ceilingEth: string;
	deltaEth: string;
	pricingSource: ApiBiddingJobPricingSource | null;
};

export type ApiBiddingPriceTierReapplyJobPreview = {
	job: ApiBiddingJob;
	before: ApiBiddingPriceTierReapplyPricePreview;
	after: ApiBiddingPriceTierReapplyPricePreview;
	changed: boolean;
};

export type BiddingPriceTierReapplyPreviewApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	tier: ApiBiddingPriceTier;
	jobs: ApiBiddingPriceTierReapplyJobPreview[];
};

export type BiddingPriceTierReapplyApplyApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	tier: ApiBiddingPriceTier;
	jobs: ApiBiddingJob[];
	preview: ApiBiddingPriceTierReapplyJobPreview[];
};

export type CollectionBiddingBidBookApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	media: ApiCollectionMediaState;
	scopeFilter: ApiCollectionBiddingBidScopeFilter;
	traits: {
		selected: ApiTokenAttribute[];
		selectedRanges: ApiTraitRangeFilter[];
		facets: ApiTraitFacet[];
	};
	bidBook: ApiBiddingBidBook;
	tokenOfferCards: ApiBiddingTokenOfferCardsPage;
};

export type TokenBiddingJobApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	tokenId: string;
	job: ApiBiddingJob | null;
};

export type TokenBiddingBidBookApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	tokenId: string;
	bidBook: ApiBiddingBidBook;
};

export type TokenBiddingJobMutationApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	tokenId: string;
	job: ApiBiddingJob;
};

export type BiddingJobTargetLookupApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	job: ApiBiddingJob | null;
};

export type BiddingJobMutationApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	job: ApiBiddingJob;
};

export type TraitBiddingJobMutationApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	job: ApiBiddingJob;
};

export type CollectionBiddingJobMutationApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	job: ApiBiddingJob;
};

export type BatchTokenBiddingJobMutationApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	tokenIds: string[];
	jobs: ApiBiddingJob[];
};

export type BatchTokenBiddingJobLookupApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	tokenIds: string[];
	jobs: ApiBiddingJob[];
	targetCount: number;
};

export type TokenDetailApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	media: ApiCollectionMediaState;
	token: ApiTokenDetail;
	traitFilterPresentation: ApiTraitFilterPresentationFeatureState;
};

export type TokenPreviewApiResponse = {
	media: ApiCollectionMediaState;
	token: ApiTokenPreview;
};

export type TokenActivitiesApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	media: ApiCollectionMediaState;
	token: ApiTokenDetail;
	activities: ApiActivitiesPage;
	included: {
		tokensById: Record<string, ApiTokenPresentationSummary>;
		eventMediaByActivityId: Record<string, ApiActivityEventMedia>;
		hasTraitSummaryTemplate: boolean;
	};
};

export type DefaultChainResponse = {
	chain: ApiChain;
};

export type ApiOpenSeaIntegrationStatus = {
	enabled: boolean;
	mode: 'auto' | 'enabled' | 'disabled';
	reason: string | null;
	missingKeys: string[];
	requiredKeys: string[];
};

export type BootstrapOpenSeaSlugProbeApiResponse = {
	chain: ApiChain;
	address: string | null;
	requestedSlug: string | null;
	status: BootstrapOpenSeaSlugProbeStatus;
	slug: string | null;
	reason: string | null;
};

export type RuntimeConfigApiResponse = {
	integrations: {
		opensea: ApiOpenSeaIntegrationStatus;
	};
	blockExplorer: {
		baseUrl: string;
		transactionPathTemplate: string;
		addressPathTemplate: string;
		blockPathTemplate: string;
	};
	bidding: {
		trustOpenSeaSignedZoneTraitOffers: boolean;
		bidBookLiveRefresh: {
			normalPollMs: number;
			competitivePollMs: number;
		};
	};
};

export type ApiBootstrapRun = {
	runId: number;
	chainId: number;
	collectionId: number;
	requestSlug: string;
	requestOpenseaSlug: string | null;
	requestAddress: string;
	requestStandard: 'erc721' | 'erc1155';
	imageSourceField: string | null;
	animationSourceField: string | null;
	metadataMode: 'strict' | 'best_effort';
	enumerationMode: 'enumerable' | 'manual_token_ids' | 'manual_range';
	manualTokenIdsJson: string | null;
	manualRangeStartTokenId: string | null;
	manualRangeTotalSupply: number | null;
	imageCacheMode: ApiImageCacheMode;
	imageCacheMaxDimension: number | null;
	deploymentBlock: number | null;
	status: BootstrapRunStatus;
	anchorBlock: number | null;
	anchorBlockHash: string | null;
	anchorBlockTimestamp: number | null;
	errorCode: string | null;
	errorMessage: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
};

export type BootstrapStatusApiResponse = {
	collection: ApiCollection & {
		bootstrapStartedAt: string | null;
		bootstrapFinishedAt: string | null;
		bootstrapLastSyncedBlock: number | null;
	};
	latestRun: ApiBootstrapRun | null;
	metadataTasks: {
		pending: number;
		retry: number;
		succeeded: number;
		failedTerminal: number;
		total: number;
	};
};

export type ApiBootstrapRunCollectionSummary = {
	chainId: number;
	collectionId: number;
	slug: string;
	address: string;
	status: CollectionStatus;
};

export type ApiBootstrapRunTaskCounts = BootstrapTaskCounts;

export type ApiBootstrapFlowStep = {
	key: BootstrapFlowStepKey;
	label: string;
	state: BootstrapFlowStepState;
	detailText: string | null;
	blocking: boolean;
	pausable: boolean;
	paused: boolean;
	availableActions: BootstrapStepAction[];
	progress: {
		completed: number;
		total: number;
	} | null;
};

export type ApiBootstrapRunFlow = {
	steps: ApiBootstrapFlowStep[];
	isTerminal: boolean;
	shouldPoll: boolean;
};

export type ApiBootstrapRunListItem = {
	run: ApiBootstrapRun;
	collection: ApiBootstrapRunCollectionSummary;
	metadataTasks: ApiBootstrapRunTaskCounts;
};

export type BootstrapRunsApiResponse = {
	chain: ApiChain;
	filters: {
		status: BootstrapRunStatus | null;
	};
	page: {
		items: ApiBootstrapRunListItem[];
		nextCursor: string | null;
		limit: number;
	};
};

export type BootstrapRunDetailApiResponse = {
	run: ApiBootstrapRun;
	collection: ApiBootstrapRunCollectionSummary;
	metadataTasks: ApiBootstrapRunTaskCounts;
	flow: ApiBootstrapRunFlow;
	failedMetadataTasksPreview: Array<{
		tokenId: string;
		status: BootstrapTaskStatus;
		attempts: number;
		nextAttemptAt: number;
		lastError: string | null;
		lastErrorAt: number | null;
	}>;
	failedMetadataTasksPreviewLimit: number;
	isLatestForCollection: boolean;
};

export type BootstrapRunCreateResponse = {
	runId: number;
	collectionId: number;
	status: string;
	createdAt: string;
};

export type BootstrapRetryFailedResponse = {
	runId: number;
	updatedCount: number;
	status: string;
};

export type BootstrapStepActionApiResponse = {
	runId: number;
	stepKey: BootstrapStepKey;
	status: BootstrapStepStatus;
};

export type ApiBlockspaceCoverageState = 'empty' | 'partial' | 'complete';

export type ApiBlockspaceCollectionOption = {
	chainId: number;
	collectionId: number;
	slug: string;
	address: string;
	status: CollectionStatus;
	deploymentBlock: number | null;
	bootstrapAnchorBlock: number | null;
	bootstrapLastSyncedBlock: number | null;
};

export type ApiBlockspaceGridCellDeploymentMarker = {
	blockNumber: number;
	synced: boolean;
};

export type ApiBlockspaceGridCell = {
	index: number;
	fromBlock: number;
	toBlock: number;
	blockCount: number;
	syncedBlockCount: number;
	state: ApiBlockspaceCoverageState;
	canDrillDown: boolean;
	collectionDeploymentBlock: ApiBlockspaceGridCellDeploymentMarker | null;
};

export type ApiBlockspaceBlockTimestamp = {
	blockNumber: number;
	timestamp: number | null;
	source: 'chain' | 'db' | 'rpc' | 'unavailable';
};

export type ApiBlockspaceRangeSummary = {
	fromBlock: number;
	toBlock: number;
	blockCount: number;
	bucketSize: number;
	syncedBlockCount: number;
	time: {
		from: ApiBlockspaceBlockTimestamp;
		to: ApiBlockspaceBlockTimestamp;
		durationSeconds: number | null;
	};
};

export type BlockspaceStateApiResponse = {
	chain: ApiChain;
	context: {
		selected: string;
		collections: ApiBlockspaceCollectionOption[];
	};
	range: {
		fromBlock: number;
		toBlock: number;
		blockCount: number;
		bucketSize: number;
		gridCellCount: number;
		canDrillDown: boolean;
		time: {
			from: ApiBlockspaceBlockTimestamp;
			to: ApiBlockspaceBlockTimestamp;
			durationSeconds: number | null;
		};
	};
	summary: {
		genesisBlock: number;
		headBlock: number;
		headSource: 'rpc' | 'indexed';
		highestSyncedBlock: number | null;
		syncedBlockCount: number;
		selectedRangeSyncedBlockCount: number;
	};
	grid: ApiBlockspaceGridCell[];
};

export type BlockspaceRangeSummaryApiResponse = {
	chain: ApiChain;
	context: {
		selected: string;
	};
	range: ApiBlockspaceRangeSummary;
};

export type ScheduleBlockspaceBackfillApiResponse = {
	chain: ApiChain;
	collection: {
		collectionId: number;
		slug: string;
	} | null;
	fromBlock: number;
	toBlock: number;
	queuedJobs: number;
};
