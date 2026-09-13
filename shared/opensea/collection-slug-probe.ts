// Status values returned when probing one OpenSea collection slug.
export const OPENSEA_COLLECTION_SLUG_PROBE_STATUS = {
    Disabled: "disabled",
    Found: "found",
    Missing: "missing",
} as const;

export type OpenSeaCollectionSlugProbeStatus =
    (typeof OPENSEA_COLLECTION_SLUG_PROBE_STATUS)[keyof typeof OPENSEA_COLLECTION_SLUG_PROBE_STATUS];

// Actionable validation shared by bootstrap and later OpenSea setup.
export const OPENSEA_COLLECTION_SLUG_PROBE_ERROR = {
    SampleRequired:
        "Enter a sample token ID before resolving the OpenSea slug.",
    SampleInvalid: "Sample token ID must be a non-negative decimal integer.",
    LocalSampleUnavailable:
        "No owned token is available locally. Wait for collection ownership sync before resolving the OpenSea slug.",
} as const;
