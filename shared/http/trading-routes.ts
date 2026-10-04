// Names trading backend routes shared with route registration and clients.
export const TRADING_API_ROUTE_TEMPLATE = {
    CompetitionPresets:
        "/api/:chain_ref/:collection_ref/bidding/competition-presets",
    CompetitionPreset:
        "/api/:chain_ref/:collection_ref/bidding/competition-presets/:preset_id",
    CompetitionPresetReapplyPreview:
        "/api/:chain_ref/:collection_ref/bidding/competition-presets/:preset_id/reapply-preview",
    CompetitionPresetReapply:
        "/api/:chain_ref/:collection_ref/bidding/competition-presets/:preset_id/reapply",
    BiddingJobCeilingPrefills: "/api/:chain_ref/bidding/jobs/ceiling-prefills",
    LookupBatchTokenBiddingJobs:
        "/api/:chain_ref/:collection_ref/bidding/jobs/tokens/lookup",
} as const;

export function buildCompetitionPresetsPath(
    chainRef: string,
    collectionRef: string,
    presetId?: string,
): string {
    const base = `/api/${encodeURIComponent(chainRef)}/${encodeURIComponent(collectionRef)}/bidding/competition-presets`;
    return presetId === undefined
        ? base
        : `${base}/${encodeURIComponent(presetId)}`;
}

export function buildCompetitionPresetReapplyPreviewPath(
    chainRef: string,
    collectionRef: string,
    presetId: string,
): string {
    return `${buildCompetitionPresetsPath(chainRef, collectionRef, presetId)}/reapply-preview`;
}

export function buildCompetitionPresetReapplyPath(
    chainRef: string,
    collectionRef: string,
    presetId: string,
): string {
    return `${buildCompetitionPresetsPath(chainRef, collectionRef, presetId)}/reapply`;
}

// Builds the client route for resolving existing jobs inside a batch token target.
export function buildLookupBatchTokenBiddingJobsPath(params: {
    chainRef: string;
    collectionRef: string;
}): string {
    return `/api/${encodeURIComponent(params.chainRef)}/${encodeURIComponent(
        params.collectionRef,
    )}/bidding/jobs/tokens/lookup`;
}
