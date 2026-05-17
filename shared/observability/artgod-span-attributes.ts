// Names ArtGod spans shared by backend routes, use cases, and read-model adapters.
export const ARTGOD_SPAN_NAME = {
    CollectionTraitFilterTokenCandidates:
        "backend.collection.db.trait_filter_token_candidates",
    CollectionOwnerTokenCandidates:
        "backend.collection.db.owner_token_candidates",
} as const;

// Names ArtGod span attributes shared by backend routes, use cases, and read-model adapters.
export const ARTGOD_SPAN_ATTRIBUTE = {
    DeploymentMode: "artgod.deployment_mode",
    ChainId: "artgod.chain_id",
    CollectionId: "artgod.collection_id",
    TokensCount: "artgod.tokens.count",
    ExtensionKey: "artgod.extension.key",
    ExtensionEventKey: "artgod.extension.event_key",
    ExtensionArtifactRef: "artgod.extension.artifact_ref",
    ActivityId: "artgod.activity.id",
    ActivityLimit: "artgod.activity.limit",
    ActivityLimitPresent: "artgod.activity.limit_present",
    ActivityCursorPresent: "artgod.activity.cursor_present",
    ActivityKind: "artgod.activity.kind",
    ActivityExtensionEvent: "artgod.activity.extension_event",
    ActivityExtensionEventPresent:
        "artgod.activity.extension_event_present",
    ActivityTraitsCount: "artgod.activity.traits_count",
    ActivityTraitRangesCount: "artgod.activity.trait_ranges_count",
    ActivityTokenFilterPresent: "artgod.activity.token_filter_present",
    ActivityMakerFilterPresent: "artgod.activity.maker_filter_present",
    ActivityContentHashFilterPresent:
        "artgod.activity.content_hash_filter_present",
    ActivityEventGroupFilterPresent:
        "artgod.activity.event_group_filter_present",
    ActivityMediaModePresent: "artgod.activity.media_mode_present",
    ActivityRangeOnlyKeysCount: "artgod.activity.range_only_keys_count",
    ActivityTokenIdsCount: "artgod.activity.token_ids_count",
    ActivityCandidateTokenIdsCount:
        "artgod.activity.candidate_token_ids_count",
    ActivityActivityIdsCount: "artgod.activity.activity_ids_count",
    ActivityRenderMode: "artgod.activity.render_mode",
    ActivityRenderModePresent: "artgod.activity.render_mode_present",
    ActivityPreviewModesCount: "artgod.activity.preview_modes_count",
    ActivityQuerySource: "artgod.activity.query_source",
    ActivityCountKind: "artgod.activity.count_kind",
    CollectionLimit: "artgod.collection.limit",
    CollectionLimitPresent: "artgod.collection.limit_present",
    CollectionCursorPresent: "artgod.collection.cursor_present",
    CollectionTokenStatus: "artgod.collection.token_status",
    CollectionOwnerPresent: "artgod.collection.owner_present",
    CollectionTraitFiltersCount:
        "artgod.collection.trait_filters_count",
    CollectionTraitRangesCount:
        "artgod.collection.trait_ranges_count",
    CollectionMediaModePresent: "artgod.collection.media_mode_present",
    CollectionRangeOnlyKeysCount:
        "artgod.collection.range_only_keys_count",
    CollectionExcludeKeysCount: "artgod.collection.exclude_keys_count",
    CollectionCountKind: "artgod.collection.count_kind",
    CollectionIncludeListings: "artgod.collection.include_listings",
    CollectionCandidateTokenIdsCount:
        "artgod.collection.candidate_token_ids_count",
    BiddingScopeFilter: "artgod.bidding.scope_filter",
    BiddingTraitJoin: "artgod.bidding.trait_join",
    BiddingLimit: "artgod.bidding.limit",
    BiddingLimitPresent: "artgod.bidding.limit_present",
    BiddingCursorPresent: "artgod.bidding.cursor_present",
    BiddingMakerFilterPresent:
        "artgod.bidding.maker_filter_present",
    BiddingMediaModePresent: "artgod.bidding.media_mode_present",
    BiddingTraitFiltersCount:
        "artgod.bidding.trait_filters_count",
    BiddingTraitRangesCount:
        "artgod.bidding.trait_ranges_count",
    BiddingRangeOnlyKeysCount:
        "artgod.bidding.range_only_keys_count",
    BiddingFacetsCount: "artgod.bidding.facets_count",
    BiddingTokenBidsCount: "artgod.bidding.token_bids_count",
    BiddingCollectionBidsCount:
        "artgod.bidding.collection_bids_count",
    BiddingTokenOfferCardsCount:
        "artgod.bidding.token_offer_cards_count",
    BiddingTokenOfferCardsTotalItems:
        "artgod.bidding.token_offer_cards_total_items",
    BiddingTokenOfferCardsTotalOffers:
        "artgod.bidding.token_offer_cards_total_offers",
    BiddingVisibleBidsCount: "artgod.bidding.visible_bids_count",
    BiddingTokenOfferGroupsCount:
        "artgod.bidding.token_offer_groups_count",
    BiddingTokenTraitsCount: "artgod.bidding.token_traits_count",
    BiddingSource: "artgod.bidding.source",
    BiddingOwnMakerPresent: "artgod.bidding.own_maker_present",
    BiddingSnapshotStaleMs: "artgod.bidding.snapshot_stale_ms",
    BiddingBidsCount: "artgod.bidding.bids_count",
    BiddingCollectionScopeBidsCount:
        "artgod.bidding.collection_scope_bids_count",
    BiddingTraitScopeBidsCount:
        "artgod.bidding.trait_scope_bids_count",
    BiddingTokenScopeBidsCount:
        "artgod.bidding.token_scope_bids_count",
    BiddingTokenSetScopeBidsCount:
        "artgod.bidding.token_set_scope_bids_count",
    BiddingUnknownScopeBidsCount:
        "artgod.bidding.unknown_scope_bids_count",
    BiddingOwnBidsCount: "artgod.bidding.own_bids_count",
    BiddingEncodedTokenIdBidsCount:
        "artgod.bidding.encoded_token_id_bids_count",
    BiddingTraitCriteriaCount:
        "artgod.bidding.trait_criteria_count",
    BiddingProjectionRowsCount:
        "artgod.bidding.projection_rows_count",
    BiddingProjectionCollectionScopeRowsCount:
        "artgod.bidding.projection_collection_scope_rows_count",
    BiddingProjectionTraitScopeRowsCount:
        "artgod.bidding.projection_trait_scope_rows_count",
    BiddingProjectionTokenScopeRowsCount:
        "artgod.bidding.projection_token_scope_rows_count",
    BiddingProjectionTokenSetScopeRowsCount:
        "artgod.bidding.projection_token_set_scope_rows_count",
    BiddingProjectionUnknownScopeRowsCount:
        "artgod.bidding.projection_unknown_scope_rows_count",
    BiddingProjectionOwnRowsCount:
        "artgod.bidding.projection_own_rows_count",
    BiddingProjectionEncodedTokenIdRowsCount:
        "artgod.bidding.projection_encoded_token_id_rows_count",
    BiddingProjectionTraitJsonRowsCount:
        "artgod.bidding.projection_trait_json_rows_count",
    BiddingOrdersRowsCount: "artgod.bidding.orders_rows_count",
    BiddingOrdersCollectionScopeRowsCount:
        "artgod.bidding.orders_collection_scope_rows_count",
    BiddingOrdersAttributeScopeRowsCount:
        "artgod.bidding.orders_attribute_scope_rows_count",
    BiddingOrdersTokenScopeRowsCount:
        "artgod.bidding.orders_token_scope_rows_count",
    BiddingOrdersTokenSetScopeRowsCount:
        "artgod.bidding.orders_token_set_scope_rows_count",
    BiddingOrdersRawRestRowsCount:
        "artgod.bidding.orders_raw_rest_rows_count",
    BiddingOrdersRawStreamRowsCount:
        "artgod.bidding.orders_raw_stream_rows_count",
    BiddingOrdersSeaportJsonRowsCount:
        "artgod.bidding.orders_seaport_json_rows_count",
    BiddingOrdersValidUntilRowsCount:
        "artgod.bidding.orders_valid_until_rows_count",
    BiddingJobsCount: "artgod.bidding.jobs_count",
    BiddingEnabledJobsCount: "artgod.bidding.enabled_jobs_count",
    BiddingPausedJobsCount: "artgod.bidding.paused_jobs_count",
    BiddingTokenJobsCount: "artgod.bidding.token_jobs_count",
    BiddingCollectionJobsCount:
        "artgod.bidding.collection_jobs_count",
    BiddingCompetitiveTraitJobsCount:
        "artgod.bidding.competitive_trait_jobs_count",
    BiddingJobTraitJsonRowsCount:
        "artgod.bidding.job_trait_json_rows_count",
    BiddingJobTargetTraitsCount:
        "artgod.bidding.job_target_traits_count",
} as const;

// Names low-cardinality trace attribute values used instead of raw invalid or absent inputs.
export const ARTGOD_TRACE_ATTRIBUTE_VALUE = {
    None: "none",
    Invalid: "invalid",
} as const;

// Names low-cardinality activity count phases recorded in read-model spans.
export const ARTGOD_ACTIVITY_COUNT_KIND = {
    Total: "total",
    BeforeCursor: "before_cursor",
} as const;

// Names low-cardinality collection count phases recorded in read-model spans.
export const ARTGOD_COLLECTION_COUNT_KIND = {
    Total: "total",
    BeforeCursor: "before_cursor",
} as const;
