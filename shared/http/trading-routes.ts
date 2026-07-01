// Backend route template for resolving existing jobs inside a batch token target.
export const TRADING_API_ROUTE_TEMPLATE = {
    LookupBatchTokenBiddingJobs:
        "/api/:chain_ref/:collection_ref/bidding/jobs/tokens/lookup",
} as const;

// Builds the client route for resolving existing jobs inside a batch token target.
export function buildLookupBatchTokenBiddingJobsPath(params: {
    chainRef: string;
    collectionRef: string;
}): string {
    return `/api/${encodeURIComponent(params.chainRef)}/${encodeURIComponent(
        params.collectionRef,
    )}/bidding/jobs/tokens/lookup`;
}
