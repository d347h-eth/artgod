export type ApiChain = {
	id: number;
	type: string;
	publicChainId: number;
	slug: string;
	name: string;
};

export type ApiCollection = {
	chainId: number;
	collectionId: string;
	slug: string | null;
	address: string;
	standard: 'erc721' | 'erc1155';
	status: 'bootstrapping' | 'live' | 'paused' | 'disabled';
	deploymentBlock: number | null;
	bootstrapAnchorBlock: number | null;
	createdAt: string;
	updatedAt: string;
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
	attributes: ApiTokenAttribute[];
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

export type DefaultChainResponse = {
	chain: ApiChain;
};
