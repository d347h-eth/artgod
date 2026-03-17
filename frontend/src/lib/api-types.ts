export type ApiChain = {
	id: number;
	type: string;
	publicChainId: number;
	slug: string;
	name: string;
};

export type ApiCollection = {
	chainId: number;
	collectionId: number;
	slug: string;
	address: string;
	standard: 'erc721' | 'erc1155';
	status: 'bootstrapping' | 'live' | 'paused' | 'disabled';
	deploymentBlock: number | null;
	bootstrapAnchorBlock: number | null;
	createdAt: string;
	updatedAt: string;
};

export type ApiCollectionHolder = {
	owner: string;
	tokenCount: string;
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

export type ApiTokenAttribute = {
	key: string;
	value: string;
};

export type ApiTokenCard = {
	tokenId: string;
	name: string | null;
	image: string | null;
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
};

export type ApiTokenDetail = {
	tokenId: string;
	name: string | null;
	image: string | null;
	animationUrl: string | null;
	attributes: ApiTokenDetailTrait[];
	hasMetadata: boolean;
	metadataUpdatedAt: string | null;
};

export type ApiTokensPage = {
	items: ApiTokenCard[];
	prevCursor: string | null;
	nextCursor: string | null;
	limit: number;
	totalItems: number;
	rangeStart: number;
	rangeEnd: number;
	currentPage: number;
	totalPages: number;
};

export type ApiTraitFacet = {
	key: string;
	values: Array<{
		value: string;
		tokenCount: number;
	}>;
};

export type CollectionsApiResponse = {
	chain: ApiChain;
	filters: {
		status: ApiCollection['status'] | null;
	};
	page: ApiCollectionsPage;
};

export type CollectionDetailApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	traits: {
		selected: ApiTokenAttribute[];
		facets: ApiTraitFacet[];
	};
	tokens: ApiTokensPage;
};

export type CollectionHoldersApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	holders: ApiCollectionHoldersPage;
};

export type TokenDetailApiResponse = {
	chain: ApiChain;
	collection: ApiCollection;
	token: ApiTokenDetail;
};

export type DefaultChainResponse = {
	chain: ApiChain;
};

export type ApiBootstrapRun = {
	runId: number;
	chainId: number;
	collectionId: number;
	requestSlug: string;
	requestOpenseaSlug: string | null;
	requestAddress: string;
	requestStandard: 'erc721' | 'erc1155';
	metadataMode: 'strict' | 'best_effort';
	enumerationMode: 'enumerable' | 'manual_token_ids' | 'manual_range';
	manualTokenIdsJson: string | null;
	manualRangeStartTokenId: string | null;
	manualRangeTotalSupply: number | null;
	deploymentBlock: number | null;
	status: 'requested' | 'queued' | 'metadata' | 'ownership' | 'backfill' | 'completed' | 'failed';
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
	status: 'bootstrapping' | 'live' | 'paused' | 'disabled';
};

export type ApiBootstrapRunTaskCounts = {
	pending: number;
	retry: number;
	succeeded: number;
	failedTerminal: number;
	total: number;
};

export type ApiBootstrapFlowStep = {
	key:
		| 'requested'
		| 'queued'
		| 'anchor'
		| 'enumeration'
		| 'metadata'
		| 'ownership'
		| 'backfill'
		| 'collection_live'
		| 'opensea_identity'
		| 'opensea_snapshot'
		| 'opensea_ready';
	label: string;
	state: 'pending' | 'active' | 'completed' | 'failed';
	detailText: string | null;
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
		status:
			| 'requested'
			| 'queued'
			| 'metadata'
			| 'ownership'
			| 'backfill'
			| 'completed'
			| 'failed'
			| null;
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
		status: 'pending' | 'retry' | 'succeeded' | 'failed_terminal';
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
