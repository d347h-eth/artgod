// Bootstrap API route templates registered by the backend.
export const BOOTSTRAP_API_ROUTE_TEMPLATE = {
    CreateRun: "/api/:chain_ref/collections/bootstrap",
    ProbeCollection: "/api/:chain_ref/collections/bootstrap/probe",
    EstimateImageCache:
        "/api/:chain_ref/collections/bootstrap/image-cache-estimate",
    ProbeOpenSeaSlug:
        "/api/:chain_ref/collections/bootstrap/opensea-slug-probe",
} as const;

const BOOTSTRAP_API_CHAIN_REF_PARAM = ":chain_ref";

// Query keys accepted by bootstrap probing endpoints.
export const BOOTSTRAP_API_QUERY_PARAM = {
    Address: "address",
    AnimationSourceField: "animation_source_field",
    ImageSourceField: "image_source_field",
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

// Builds the backend route used to probe a collection before bootstrap creation.
export function buildProbeBootstrapCollectionPath(input: {
    chainRef: string;
    address: string;
    standard: string;
    imageSourceField?: string | null;
    animationSourceField?: string | null;
    sampleTokenId?: string | null;
}): string {
    const query = new URLSearchParams();
    query.set(BOOTSTRAP_API_QUERY_PARAM.Address, input.address);
    query.set(BOOTSTRAP_API_QUERY_PARAM.Standard, input.standard);
    if (input.imageSourceField?.trim()) {
        query.set(
            BOOTSTRAP_API_QUERY_PARAM.ImageSourceField,
            input.imageSourceField.trim(),
        );
    }
    if (input.animationSourceField?.trim()) {
        query.set(
            BOOTSTRAP_API_QUERY_PARAM.AnimationSourceField,
            input.animationSourceField.trim(),
        );
    }
    if (input.sampleTokenId?.trim()) {
        query.set(
            BOOTSTRAP_API_QUERY_PARAM.SampleTokenId,
            input.sampleTokenId.trim(),
        );
    }
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

type ProbeBootstrapOpenSeaSlugPathInput =
    | {
          chainRef: string;
          address: string;
          slug?: never;
      }
    | {
          chainRef: string;
          address?: never;
          slug: string;
      };

// Builds the backend route used to resolve or verify a bootstrap OpenSea slug.
export function buildProbeBootstrapOpenSeaSlugPath(
    input: ProbeBootstrapOpenSeaSlugPathInput,
): string {
    const query = new URLSearchParams();
    if (input.address !== undefined) {
        query.set(BOOTSTRAP_API_QUERY_PARAM.Address, input.address);
    } else {
        query.set(BOOTSTRAP_API_QUERY_PARAM.Slug, input.slug);
    }
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
