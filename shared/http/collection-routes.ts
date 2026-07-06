// Collection action API route templates registered by the backend.
export const COLLECTION_API_ROUTE_TEMPLATE = {
    StartBootstrap: "/api/:chain_ref/:collection_ref/bootstrap/start",
    StartOpenSeaSync: "/api/:chain_ref/:collection_ref/opensea/sync",
} as const;

const COLLECTION_API_CHAIN_REF_PARAM = ":chain_ref";
const COLLECTION_API_COLLECTION_REF_PARAM = ":collection_ref";

// Builds the backend route used to start bootstrap for a prepared collection.
export function buildStartCollectionBootstrapPath(input: {
    chainRef: string;
    collectionRef: string;
}): string {
    return buildCollectionRoute(
        COLLECTION_API_ROUTE_TEMPLATE.StartBootstrap,
        input,
    );
}

// Builds the backend route used to start or retry OpenSea sync for a live collection.
export function buildStartCollectionOpenSeaSyncPath(input: {
    chainRef: string;
    collectionRef: string;
}): string {
    return buildCollectionRoute(
        COLLECTION_API_ROUTE_TEMPLATE.StartOpenSeaSync,
        input,
    );
}

function buildCollectionRoute(
    template: string,
    input: {
        chainRef: string;
        collectionRef: string;
    },
): string {
    return template
        .replace(
            COLLECTION_API_CHAIN_REF_PARAM,
            encodeURIComponent(input.chainRef),
        )
        .replace(
            COLLECTION_API_COLLECTION_REF_PARAM,
            encodeURIComponent(input.collectionRef),
        );
}
