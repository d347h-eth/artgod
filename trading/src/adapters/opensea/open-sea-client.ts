export interface OpenSeaGetOrdersQuery {
    assetContractAddress: string;
    tokenIds: string[];
    side: string;
    orderBy: string;
    orderDirection: string;
    paymentTokenAddress: string;
    maker?: string;
}

export interface OpenSeaOffersPage {
    offers?: unknown[];
    next?: string;
}

export interface OpenSeaGetOrdersResponse {
    orders?: unknown[];
}

export interface OpenSeaTraitsResponse {
    counts?: Record<string, Record<string, unknown>>;
}

// OpenSeaApiClient is the minimal API surface the bidding adapters need from the SDK.
export interface OpenSeaApiClient {
    getOrders(query: OpenSeaGetOrdersQuery): Promise<OpenSeaGetOrdersResponse>;
    getAllOffers(
        collectionSlug: string,
        limit?: number,
        next?: string,
    ): Promise<OpenSeaOffersPage>;
    getOrderByHash(orderHash: string, protocolAddress: string): Promise<unknown>;
    getCollectionOffers(
        collectionSlug: string,
        limit?: number,
        next?: string,
    ): Promise<OpenSeaOffersPage>;
    getTraitOffers(
        collectionSlug: string,
        traitType: string,
        traitValue: string,
        limit?: number,
        next?: string,
    ): Promise<OpenSeaOffersPage>;
    getTraits(collectionSlug: string): Promise<OpenSeaTraitsResponse>;
    getBestOffer(collectionSlug: string, tokenId: string): Promise<unknown>;
}

export interface OpenSeaCreateOfferResponse {
    orderHash?: string;
    order_hash?: string;
    protocolAddress?: string;
    protocol_address?: string;
    expirationTime?: number | string;
    expiration_time?: number | string;
}

export interface OpenSeaCreateCollectionOfferResponse
    extends OpenSeaCreateOfferResponse {}

export interface OpenSeaCreateOfferInput {
    asset: {
        tokenAddress: string;
        tokenId: string;
    };
    accountAddress: string;
    amount: string;
    expirationTime: number;
}

export interface OpenSeaCreateCollectionOfferInput {
    collectionSlug: string;
    accountAddress: string;
    amount: string;
    quantity: number;
    traitType?: string;
    traitValue?: string;
    traits?: Array<{ type: string; value: string }>;
    expirationTime: number;
}

// OpenSeaBiddingSdkClient is the minimal mixed API/SDK surface needed for bid placement and cancellation.
export interface OpenSeaBiddingSdkClient {
    api: OpenSeaApiClient;
    createOffer(
        input: OpenSeaCreateOfferInput,
    ): Promise<OpenSeaCreateOfferResponse>;
    createCollectionOffer(
        input: OpenSeaCreateCollectionOfferInput,
    ): Promise<OpenSeaCreateCollectionOfferResponse | null>;
    offchainCancelOrder(
        protocolAddress: string,
        orderHash: string,
        chain?: string,
        offererSignature?: string,
        useSignerToDeriveOffererSignature?: boolean,
    ): Promise<unknown>;
}
