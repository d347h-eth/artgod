import { db } from "@artgod/shared/database";
import { buildSyncFollowUps } from "../../src/application/sync-range-processing.js";
import { createMetadataRefreshRangeHandler } from "../../src/application/metadata/refresh-range.js";
import { CanonicalSyncJobAdmission } from "../../src/application/canonical-sync-job-admission.js";
import {
    DOMAIN_JOB_KIND,
    METADATA_REFRESH_SOURCE,
    type MetadataRefreshRangePayload,
} from "../../src/domain/domain-jobs.js";
import { SYNC_WORK_COMPLETION } from "../../src/domain/sync-work.js";
import {
    BACKFILL_ORDER_MAINTENANCE_POLICY,
    SYNC_JOB_KIND,
} from "../../src/domain/sync-jobs.js";
import type { JobEnvelope } from "../../src/domain/jobs.js";
import type { QueuePort } from "../../src/ports/queue.js";
import { SqliteMetadataDomain } from "../../src/infra/domain/metadata.js";
import { SqliteMetadataRefreshFollowups } from "../../src/infra/metadata/sqlite-refresh-followups.js";
import { SqliteCollectionExtensions } from "../../src/infra/collection-extensions/sqlite.js";
import { SqliteImageCachePolicyResolver } from "../../src/infra/media/sqlite-image-cache-policy.js";
import {
    RecoveryRpc,
    reorgRecoveryServices,
} from "./reorg-recovery-fixture.js";
import { insertCollection, emptyOnChainData } from "./ownership-fixture.js";
import { syncBlockFixture } from "./chain-fixture.js";
import { commitRollbackFixture } from "./rollback-fixture.js";

// Actual production acquisition/retention, metadata persistence, follow-ups and
// handler; only token URI/HTTP responses and the caller's publisher are fixtures.
export function metadataRangeFixture(input: {
    queue: Pick<QueuePort, "publish">;
    tokenCount?: number;
}) {
    const services = reorgRecoveryServices(new RecoveryRpc(200));
    const collectionId = insertCollection({
        chainId: 1,
        slug: "metadata-range",
        address: "0x1111111111111111111111111111111111111111",
        anchorBlock: 100,
    });
    const collection = services.registry.getCollection(1, collectionId)!;
    let version = 0;
    const uriReads: Array<{ tokenId: string; version: number }> = [];
    const metadata = new SqliteMetadataDomain(
        {
            resolveTokenUri: async (_contract, tokenId) => {
                uriReads.push({ tokenId, version });
                return `fixture:${tokenId}:${version}`;
            },
        },
        {
            fetchMetadata: async (uri) => ({
                uri,
                name: `version-${version}`,
                attributes: [],
                rawJson: "{}",
            }),
        },
    );
    const extensions = new SqliteCollectionExtensions({
        persistRawDebugPayloads: false,
    });
    const handler = createMetadataRefreshRangeHandler({
        queue: input.queue,
        metadata,
        followups: new SqliteMetadataRefreshFollowups(services.outbox),
        extensions,
        imagePolicy: new SqliteImageCachePolicyResolver(extensions),
        chunkSize: 2,
    });
    const tokenCount = input.tokenCount ?? 6;
    function commitRoot(replacement: boolean) {
        const block = {
            ...syncBlockFixture(103),
            ...(replacement ? { hash: syncBlockFixture(10_103).hash } : {}),
        };
        const data = emptyOnChainData();
        data.collectionScoped.metadataRefreshRangeEvents.push({
            collectionId,
            contract: collection.address,
            fromTokenId: "1",
            toTokenId: String(tokenCount),
            reason: "range-fixture",
            trigger: "range-fixture",
            blockNumber: block.number,
            blockHash: block.hash,
            txHash: syncBlockFixture(903).hash,
            logIndex: 1,
        });
        const followUps = buildSyncFollowUps(
            1,
            [collection],
            { fromBlock: 102, toBlock: 103 },
            [
                {
                    fanoutId: "metadata-range-root",
                    sourceJobId: "metadata-range-root",
                    sourceKind: SYNC_JOB_KIND.BackfillRange,
                },
            ],
            "backfill",
            data,
            BACKFILL_ORDER_MAINTENANCE_POLICY.CurrentState,
        );
        services.commit.commitSyncRange({
            result: {
                checkpoint: services.storage.captureSyncCheckpoint(1),
                blocks: [syncBlockFixture(102), block],
                data,
                collections: [collection],
            },
            followUps,
            completion: { kind: SYNC_WORK_COMPLETION.Unmanaged },
        });
        const job = services.outbox
            .listDue(Date.now(), 100)
            .map(
                (row) =>
                    JSON.parse(
                        row.jobJson,
                    ) as JobEnvelope<MetadataRefreshRangePayload>,
            )
            .find(
                (job) =>
                    job.kind === DOMAIN_JOB_KIND.MetadataRefreshRange &&
                    job.onchainBlock?.blockHash === block.hash,
            );
        if (!job) throw new Error("Missing retained metadata range root");
        if (job.payload.source !== METADATA_REFRESH_SOURCE.Onchain)
            throw new Error("Wrong fixture root source");
        return job;
    }
    const root = commitRoot(false);
    return {
        ...services,
        collectionId,
        handler,
        root,
        uriReads,
        admission: new CanonicalSyncJobAdmission(services.storage),
        replace: () => {
            commitRollbackFixture({
                storage: services.storage,
                chainId: 1,
                fromBlock: 103,
                owners: [],
            });
            version = 1;
            return commitRoot(true);
        },
        rollback: () =>
            commitRollbackFixture({
                storage: services.storage,
                chainId: 1,
                fromBlock: 103,
                owners: [],
            }),
        metadataRows: () =>
            db
                .prepare(
                    "SELECT token_id, name FROM token_metadata WHERE chain_id = 1 AND collection_id = ? ORDER BY CAST(token_id AS INTEGER)",
                )
                .all(collectionId) as Array<{ token_id: string; name: string }>,
    };
}
