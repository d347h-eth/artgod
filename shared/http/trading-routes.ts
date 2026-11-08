// Names trading backend routes shared with route registration and clients.
const PRICE_TIERS_ROUTE = "/api/:chain_ref/:collection_ref/bidding/price-tiers";
export const TRADING_API_ROUTE_TEMPLATE = {
    BiddingPriceTiers: PRICE_TIERS_ROUTE,
    BiddingPriceTier: `${PRICE_TIERS_ROUTE}/:tier_id`,
    BiddingPriceTierReapplyPreview: `${PRICE_TIERS_ROUTE}/:tier_id/reapply-preview`,
    BiddingPriceTierReapply: `${PRICE_TIERS_ROUTE}/:tier_id/reapply`,
    TokenBiddingJob: "/api/:chain_ref/:collection_ref/:token_ref/bidding/job",
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

export function buildBiddingPriceTiersPath(
    chainRef: string,
    collectionRef: string,
    tierId?: string,
): string {
    return buildTradingRoute(
        tierId === undefined
            ? TRADING_API_ROUTE_TEMPLATE.BiddingPriceTiers
            : TRADING_API_ROUTE_TEMPLATE.BiddingPriceTier,
        { chain_ref: chainRef, collection_ref: collectionRef, tier_id: tierId },
    );
}

export function buildBiddingPriceTierReapplyPreviewPath(
    chainRef: string,
    collectionRef: string,
    tierId: string,
): string {
    return buildTradingRoute(
        TRADING_API_ROUTE_TEMPLATE.BiddingPriceTierReapplyPreview,
        { chain_ref: chainRef, collection_ref: collectionRef, tier_id: tierId },
    );
}

export function buildBiddingPriceTierReapplyPath(
    chainRef: string,
    collectionRef: string,
    tierId: string,
): string {
    return buildTradingRoute(
        TRADING_API_ROUTE_TEMPLATE.BiddingPriceTierReapply,
        { chain_ref: chainRef, collection_ref: collectionRef, tier_id: tierId },
    );
}

export function buildTokenBiddingJobPath(
    chainRef: string,
    collectionRef: string,
    tokenRef: string,
): string {
    return buildTradingRoute(TRADING_API_ROUTE_TEMPLATE.TokenBiddingJob, {
        chain_ref: chainRef,
        collection_ref: collectionRef,
        token_ref: tokenRef,
    });
}

export function buildCompetitionPresetsPath(
    chainRef: string,
    collectionRef: string,
    presetId?: string,
): string {
    return buildTradingRoute(
        presetId === undefined
            ? TRADING_API_ROUTE_TEMPLATE.CompetitionPresets
            : TRADING_API_ROUTE_TEMPLATE.CompetitionPreset,
        {
            chain_ref: chainRef,
            collection_ref: collectionRef,
            preset_id: presetId,
        },
    );
}

export function buildCompetitionPresetReapplyPreviewPath(
    chainRef: string,
    collectionRef: string,
    presetId: string,
): string {
    return buildTradingRoute(
        TRADING_API_ROUTE_TEMPLATE.CompetitionPresetReapplyPreview,
        {
            chain_ref: chainRef,
            collection_ref: collectionRef,
            preset_id: presetId,
        },
    );
}

export function buildCompetitionPresetReapplyPath(
    chainRef: string,
    collectionRef: string,
    presetId: string,
): string {
    return buildTradingRoute(
        TRADING_API_ROUTE_TEMPLATE.CompetitionPresetReapply,
        {
            chain_ref: chainRef,
            collection_ref: collectionRef,
            preset_id: presetId,
        },
    );
}

// Builds the client route for resolving existing jobs inside a batch token target.
export function buildLookupBatchTokenBiddingJobsPath(params: {
    chainRef: string;
    collectionRef: string;
}): string {
    return buildTradingRoute(
        TRADING_API_ROUTE_TEMPLATE.LookupBatchTokenBiddingJobs,
        { chain_ref: params.chainRef, collection_ref: params.collectionRef },
    );
}

function buildTradingRoute(
    template: string,
    params: Record<string, string | undefined>,
): string {
    return template.replace(/:([a-z_]+)/g, (_match, key: string) => {
        const value = params[key];
        if (value === undefined)
            throw new Error(`Missing trading route parameter: ${key}`);
        return encodeURIComponent(value);
    });
}
