import type { ChainsReadPort, CollectionsReadPort } from "../ports/read-models.js";

export type ApiRouteDependencies = {
    defaultChainId: number;
    chainsReadModel: ChainsReadPort;
    collectionsReadModel: CollectionsReadPort;
};

export type ChainsDefaultRoute = {
    Params: Record<string, never>;
};

export type CollectionsRoute = {
    Params: {
        chain_ref: string;
    };
};

export type CollectionDetailRoute = {
    Params: {
        chain_ref: string;
        collection_ref: string;
    };
};
