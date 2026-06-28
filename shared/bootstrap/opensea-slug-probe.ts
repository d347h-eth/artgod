// Status values returned by the bootstrap OpenSea slug probe endpoint.
export const BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS = {
    Disabled: "disabled",
    Found: "found",
    Missing: "missing",
} as const;

export type BootstrapOpenSeaSlugProbeStatus =
    (typeof BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS)[keyof typeof BOOTSTRAP_OPENSEA_SLUG_PROBE_STATUS];
