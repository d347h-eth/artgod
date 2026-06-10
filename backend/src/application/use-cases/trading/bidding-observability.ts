import {
    ARTGOD_SPAN_ATTRIBUTE,
    ARTGOD_TRACE_ATTRIBUTE_VALUE,
} from "@artgod/shared/observability";

// Names bidding route/span attributes shared across HTTP, use-case, and SQLite instrumentation.
export const BIDDING_SPAN_ATTRIBUTE = {
    ChainId: ARTGOD_SPAN_ATTRIBUTE.ChainId,
    CollectionId: ARTGOD_SPAN_ATTRIBUTE.CollectionId,
    TokensCount: ARTGOD_SPAN_ATTRIBUTE.TokensCount,
    CollectionIncludeListings:
        ARTGOD_SPAN_ATTRIBUTE.CollectionIncludeListings,
    ScopeFilter: ARTGOD_SPAN_ATTRIBUTE.BiddingScopeFilter,
    TraitJoin: ARTGOD_SPAN_ATTRIBUTE.BiddingTraitJoin,
    Limit: ARTGOD_SPAN_ATTRIBUTE.BiddingLimit,
    LimitPresent: ARTGOD_SPAN_ATTRIBUTE.BiddingLimitPresent,
    CursorPresent: ARTGOD_SPAN_ATTRIBUTE.BiddingCursorPresent,
    MakerFilterPresent:
        ARTGOD_SPAN_ATTRIBUTE.BiddingMakerFilterPresent,
    MediaModePresent: ARTGOD_SPAN_ATTRIBUTE.BiddingMediaModePresent,
    TraitFiltersCount: ARTGOD_SPAN_ATTRIBUTE.BiddingTraitFiltersCount,
    TraitRangesCount: ARTGOD_SPAN_ATTRIBUTE.BiddingTraitRangesCount,
    RangeOnlyKeysCount: ARTGOD_SPAN_ATTRIBUTE.BiddingRangeOnlyKeysCount,
    FacetsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingFacetsCount,
    TokenBidsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingTokenBidsCount,
    CollectionBidsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingCollectionBidsCount,
    TokenOfferCardsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingTokenOfferCardsCount,
    TokenOfferCardsTotalItems:
        ARTGOD_SPAN_ATTRIBUTE.BiddingTokenOfferCardsTotalItems,
    TokenOfferCardsTotalOffers:
        ARTGOD_SPAN_ATTRIBUTE.BiddingTokenOfferCardsTotalOffers,
    VisibleBidsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingVisibleBidsCount,
    TokenOfferGroupsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingTokenOfferGroupsCount,
    TokenTraitsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingTokenTraitsCount,
    Source: ARTGOD_SPAN_ATTRIBUTE.BiddingSource,
    OwnMakerPresent: ARTGOD_SPAN_ATTRIBUTE.BiddingOwnMakerPresent,
    SnapshotStaleMs: ARTGOD_SPAN_ATTRIBUTE.BiddingSnapshotStaleMs,
    BidsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingBidsCount,
    CollectionScopeBidsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingCollectionScopeBidsCount,
    TraitScopeBidsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingTraitScopeBidsCount,
    TokenScopeBidsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingTokenScopeBidsCount,
    TokenSetScopeBidsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingTokenSetScopeBidsCount,
    UnknownScopeBidsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingUnknownScopeBidsCount,
    OwnBidsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingOwnBidsCount,
    EncodedTokenIdBidsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingEncodedTokenIdBidsCount,
    TraitCriteriaCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingTraitCriteriaCount,
    ProjectionRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingProjectionRowsCount,
    ProjectionCollectionScopeRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingProjectionCollectionScopeRowsCount,
    ProjectionTraitScopeRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingProjectionTraitScopeRowsCount,
    ProjectionTokenScopeRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingProjectionTokenScopeRowsCount,
    ProjectionTokenSetScopeRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingProjectionTokenSetScopeRowsCount,
    ProjectionUnknownScopeRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingProjectionUnknownScopeRowsCount,
    ProjectionOwnRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingProjectionOwnRowsCount,
    ProjectionEncodedTokenIdRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingProjectionEncodedTokenIdRowsCount,
    ProjectionTraitJsonRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingProjectionTraitJsonRowsCount,
    OrdersRowsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingOrdersRowsCount,
    OrdersCollectionScopeRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingOrdersCollectionScopeRowsCount,
    OrdersAttributeScopeRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingOrdersAttributeScopeRowsCount,
    OrdersTokenScopeRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingOrdersTokenScopeRowsCount,
    OrdersTokenSetScopeRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingOrdersTokenSetScopeRowsCount,
    OrdersSeaportJsonRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingOrdersSeaportJsonRowsCount,
    OrdersValidUntilRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingOrdersValidUntilRowsCount,
    JobsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingJobsCount,
    EnabledJobsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingEnabledJobsCount,
    PausedJobsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingPausedJobsCount,
    TokenJobsCount: ARTGOD_SPAN_ATTRIBUTE.BiddingTokenJobsCount,
    CollectionJobsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingCollectionJobsCount,
    CompetitiveTraitJobsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingCompetitiveTraitJobsCount,
    JobTraitJsonRowsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingJobTraitJsonRowsCount,
    JobTargetTraitsCount:
        ARTGOD_SPAN_ATTRIBUTE.BiddingJobTargetTraitsCount,
} as const;

// Names low-cardinality labels used when raw input cannot be safely emitted.
export const TRACE_ATTRIBUTE_VALUE = {
    Invalid: ARTGOD_TRACE_ATTRIBUTE_VALUE.Invalid,
} as const;
