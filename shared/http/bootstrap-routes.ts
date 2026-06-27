// Bootstrap API route templates registered by the backend.
export const BOOTSTRAP_API_ROUTE_TEMPLATE = {
    CreateRun: "/api/:chain_ref/collections/bootstrap",
    ProbeCollection: "/api/:chain_ref/collections/bootstrap/probe",
} as const;

const BOOTSTRAP_API_CHAIN_REF_PARAM = ":chain_ref";

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
    query.set("address", input.address);
    query.set("standard", input.standard);
    return `${buildBootstrapChainRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.ProbeCollection,
        input.chainRef,
    )}?${query.toString()}`;
}

function buildBootstrapChainRoute(template: string, chainRef: string): string {
    return template.replace(
        BOOTSTRAP_API_CHAIN_REF_PARAM,
        encodeURIComponent(chainRef),
    );
}
