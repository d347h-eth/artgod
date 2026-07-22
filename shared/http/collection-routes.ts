// Collection action API route templates registered by the backend.
export const COLLECTION_API_ROUTE_TEMPLATE = {
    StartBootstrap: "/api/:chain_ref/:collection_ref/bootstrap/start",
    ProbeOpenSeaSlug: "/api/:chain_ref/:collection_ref/opensea/slug-probe",
    StartOpenSeaSync: "/api/:chain_ref/:collection_ref/opensea/sync",
    UpdateOpenSeaStreamIngestion:
        "/api/:chain_ref/:collection_ref/opensea/stream-ingestion",
} as const;

const COLLECTION_API_CHAIN_REF_PARAM = ":chain_ref";
const COLLECTION_API_COLLECTION_REF_PARAM = ":collection_ref";

// Query keys accepted by collection action endpoints.
export const COLLECTION_API_QUERY_PARAM = {
    OpenSeaSlug: "slug",
} as const;

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

// Builds the backend route used to resolve or verify a live collection's OpenSea slug.
export function buildProbeCollectionOpenSeaSlugPath(input: {
    chainRef: string;
    collectionRef: string;
    slug?: string;
}): string {
    const path = buildCollectionRoute(
        COLLECTION_API_ROUTE_TEMPLATE.ProbeOpenSeaSlug,
        input,
    );
    const slug = input.slug?.trim();
    if (!slug) return path;
    const query = new URLSearchParams();
    query.set(COLLECTION_API_QUERY_PARAM.OpenSeaSlug, slug);
    return `${path}?${query.toString()}`;
}

// Builds the backend route used to pause or resume OpenSea stream ingestion for a collection.
export function buildUpdateCollectionOpenSeaStreamIngestionPath(input: {
    chainRef: string;
    collectionRef: string;
}): string {
    return buildCollectionRoute(
        COLLECTION_API_ROUTE_TEMPLATE.UpdateOpenSeaStreamIngestion,
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
