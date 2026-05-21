import type { SpanAttributes } from "@artgod/shared/observability/apm";
import { ARTGOD_SPAN_ATTRIBUTE } from "@artgod/shared/observability";
import type {
    SyncBackfillCoverageContext,
    SyncBackfillCoverageRange,
} from "./get-sync-backfill-state.js";

// Names sync/backfill spans and attributes shared by use-case and infra instrumentation.
export const SYNC_BACKFILL_SPAN_ATTRIBUTE = {
    ChainId: ARTGOD_SPAN_ATTRIBUTE.ChainId,
    CollectionId: ARTGOD_SPAN_ATTRIBUTE.CollectionId,
    ContextKind: "artgod.sync_backfill.context_kind",
    CollectionRefPresent: "artgod.sync_backfill.collection_ref_present",
    PageStartPresent: "artgod.sync_backfill.page_start_present",
    PageStartBlock: "artgod.sync_backfill.page_start_block",
    BucketSize: "artgod.sync_backfill.bucket_size",
    FromBlock: "artgod.sync_backfill.from_block",
    ToBlock: "artgod.sync_backfill.to_block",
    BlockNumber: "artgod.sync_backfill.block_number",
    BlockCount: "artgod.sync_backfill.block_count",
    RangesCount: "artgod.sync_backfill.ranges_count",
    CommandsCount: "artgod.sync_backfill.commands_count",
    HeadSource: "artgod.sync_backfill.head_source",
    TimestampSource: "artgod.sync_backfill.timestamp_source",
    DeploymentBlockPresent: "artgod.sync_backfill.deployment_block_present",
    BucketQueryPresent: "artgod.sync_backfill.bucket_query_present",
} as const;

// Builds low-cardinality context labels for sync/backfill coverage spans.
export function syncBackfillContextSpanAttributes(
    context: SyncBackfillCoverageContext,
): SpanAttributes {
    return {
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.ContextKind]: context.kind,
        ...(context.kind === "collection"
            ? {
                  [SYNC_BACKFILL_SPAN_ATTRIBUTE.CollectionId]:
                      context.collectionId,
                  [SYNC_BACKFILL_SPAN_ATTRIBUTE.DeploymentBlockPresent]:
                      context.deploymentBlock !== null,
              }
            : {}),
    };
}

// Builds common block-range labels for page and bucket-count spans.
export function syncBackfillRangeSpanAttributes(
    range: SyncBackfillCoverageRange,
): SpanAttributes {
    return {
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.FromBlock]: range.fromBlock,
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.ToBlock]: range.toBlock,
        [SYNC_BACKFILL_SPAN_ATTRIBUTE.BlockCount]:
            range.fromBlock > range.toBlock
                ? 0
                : range.toBlock - range.fromBlock + 1,
    };
}
