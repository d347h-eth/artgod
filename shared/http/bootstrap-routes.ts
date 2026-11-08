// Bootstrap API route templates registered by the backend.
export const BOOTSTRAP_API_ROUTE_TEMPLATE = {
    CreateRun: "/api/:chain_ref/collections/bootstrap",
    InspectSample: "/api/:chain_ref/collections/bootstrap/sample",
    ProbeCollection: "/api/:chain_ref/collections/bootstrap/probe",
    EstimateImageCache:
        "/api/:chain_ref/collections/bootstrap/image-cache-estimate",
    ProbeOpenSeaSlug:
        "/api/:chain_ref/collections/bootstrap/opensea-slug-probe",
    RunDetail: "/api/:chain_ref/bootstrap-runs/:run_id",
    RetryFailedTasks: "/api/:chain_ref/bootstrap-runs/:run_id/retry-failed",
    StepAction:
        "/api/:chain_ref/bootstrap-runs/:run_id/steps/:step_key/:action",
} as const;

const BOOTSTRAP_API_CHAIN_REF_PARAM = ":chain_ref";

// Query keys accepted by bootstrap probing endpoints.
export const BOOTSTRAP_API_QUERY_PARAM = {
    Address: "address",
    SampleTokenId: "sample_token_id",
    Slug: "slug",
    Standard: "standard",
} as const;

// Builds the backend route used to create a durable collection bootstrap run.
export function buildCreateBootstrapRunPath(chainRef: string): string {
    return buildBootstrapChainRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.CreateRun,
        chainRef,
    );
}

export function buildBootstrapRunDetailPath(
    chainRef: string,
    runId: number,
): string {
    return buildBootstrapRunRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.RunDetail,
        chainRef,
        runId,
    );
}

export function buildRetryBootstrapFailedTasksPath(
    chainRef: string,
    runId: number,
): string {
    return buildBootstrapRunRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.RetryFailedTasks,
        chainRef,
        runId,
    );
}

export function buildBootstrapStepActionPath(
    chainRef: string,
    runId: number,
    stepKey: string,
    action: string,
): string {
    return buildBootstrapRunRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.StepAction,
        chainRef,
        runId,
    )
        .replace(":step_key", encodeURIComponent(stepKey))
        .replace(":action", encodeURIComponent(action));
}

function buildBootstrapRunRoute(
    template: string,
    chainRef: string,
    runId: number,
): string {
    return buildBootstrapChainRoute(template, chainRef).replace(
        ":run_id",
        encodeURIComponent(String(runId)),
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

// Builds the backend route used to estimate sample-image cache output.
export function buildEstimateBootstrapImageCachePath(chainRef: string): string {
    return buildBootstrapChainRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.EstimateImageCache,
        chainRef,
    );
}

type ProbeBootstrapOpenSeaSlugPathInput = {
    chainRef: string;
    address: string;
    slug?: string;
    sampleTokenId: string;
};

// Builds the backend route used to resolve or verify a bootstrap OpenSea slug.
export function buildProbeBootstrapOpenSeaSlugPath(
    input: ProbeBootstrapOpenSeaSlugPathInput,
): string {
    const query = new URLSearchParams();
    if (input.address !== undefined) {
        query.set(BOOTSTRAP_API_QUERY_PARAM.Address, input.address);
    }
    if (input.slug !== undefined) {
        query.set(BOOTSTRAP_API_QUERY_PARAM.Slug, input.slug);
    }
    query.set(BOOTSTRAP_API_QUERY_PARAM.SampleTokenId, input.sampleTokenId);
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

export function buildInspectBootstrapSamplePath(chainRef: string): string {
    return buildBootstrapChainRoute(
        BOOTSTRAP_API_ROUTE_TEMPLATE.InspectSample,
        chainRef,
    );
}
