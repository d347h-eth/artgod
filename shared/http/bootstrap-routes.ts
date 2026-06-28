// Bootstrap API route templates registered by the backend.
export const BOOTSTRAP_API_ROUTE_TEMPLATE = {
    CreateRun: "/api/:chain_ref/collections/bootstrap",
    ProbeCollection: "/api/:chain_ref/collections/bootstrap/probe",
    ProbeOpenSeaSlug:
        "/api/:chain_ref/collections/bootstrap/opensea-slug-probe",
} as const;

const BOOTSTRAP_API_CHAIN_REF_PARAM = ":chain_ref";

// Query keys accepted by bootstrap probing endpoints.
export const BOOTSTRAP_API_QUERY_PARAM = {
    Address: "address",
    Standard: "standard",
} as const;

// Builds the backend route used to create a durable collection bootstrap run.
export function buildCreateBootstrapRunPath(chainRef: string): string {
    return buildBootstrapChainRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.CreateRun,
        chainRef,
    );
}

// Builds the backend route used to probe a collection before bootstrap creation.
export function buildProbeBootstrapCollectionPath(input: {
    chainRef: string;
    address: string;
    standard: string;
}): string {
    const query = new URLSearchParams();
    query.set(BOOTSTRAP_API_QUERY_PARAM.Address, input.address);
    query.set(BOOTSTRAP_API_QUERY_PARAM.Standard, input.standard);
    return `${buildBootstrapChainRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.ProbeCollection,
        input.chainRef,
    )}?${query.toString()}`;
}

// Builds the backend route used to resolve an OpenSea slug from a contract address.
export function buildProbeBootstrapOpenSeaSlugPath(input: {
    chainRef: string;
    address: string;
}): string {
    const query = new URLSearchParams();
    query.set(BOOTSTRAP_API_QUERY_PARAM.Address, input.address);
    return `${buildBootstrapChainRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.ProbeOpenSeaSlug,
        input.chainRef,
    )}?${query.toString()}`;
}

function buildBootstrapChainRoute(template: string, chainRef: string): string {
    return template.replace(
        BOOTSTRAP_API_CHAIN_REF_PARAM,
        encodeURIComponent(chainRef),
    );
}
