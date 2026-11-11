import { randomUUID } from "node:crypto";
import { zeroAddress } from "viem";
import { db } from "@artgod/shared/database";
import { COLLECTION_STATUS } from "@artgod/shared/types";
import {
    getDefaultDebugPayloadPersistenceConfig,
    type DebugPayloadPersistenceConfig,
} from "@artgod/shared/config/debug-payload-persistence";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "@artgod/shared/types/token-attributes";
import { TOKEN_RECORD_KIND } from "@artgod/shared/types/token-records";
import type {
    TokenMetadata,
    TokenStandard,
    MetadataUpdatedToken,
} from "../../domain/metadata.js";
import {
    METADATA_PENDING_POLICY as POLICY,
    METADATA_PENDING_REASON as REASON,
    metadataRetryDelay,
    isMetadataHostingFailure,
    type MetadataAttempt,
    type MetadataAttribution,
    type MetadataFetchOptions,
    type MetadataPendingReason,
    type MetadataTarget,
} from "../../domain/metadata-pending.js";
import type { DomainSyncContext } from "../../ports/domain-handlers.js";
import type {
    MetadataCandidate,
    MetadataStorePort,
} from "../../ports/metadata-store.js";
import { normalizeUniqueAttributeList } from "../../domain/attributes.js";
import { COLLECTION_STANDARD } from "../../domain/collections.js";
import { SqliteTokenAttributeWriter } from "../attributes/sqlite-token-attributes.js";
import { captureChainSyncCheckpoint } from "../storage/sqlite-chain-revisions.js";

type TokenRow = {
    collection_id: number;
    contract: string;
    token_id: string;
    kind: TokenStandard;
    block_number: number;
    block_hash: string;
    block_timestamp: number;
    tx_hash: string;
    log_index: number;
};
type MetadataRow = { present: 1 };
type CollectionMetadataContextRow = {
    collection_id: number;
    address: string;
    standard: TokenStandard;
};
type PendingRow = {
    chain_id: number;
    collection_id: number;
    token_id: string;
    options_json: string;
    attempts: number;
    failures: number;
    lease_owner: string;
    due_at: number;
};

/** SQLite owns canonical writes and pending intent in one transaction. */
export class SqliteMetadataStore implements MetadataStorePort {
    private collectionCursor = 0;
    private selectMetadata = db.prepare<[number, number, string]>(
        "SELECT 1 AS present FROM token_metadata WHERE chain_id = ? AND collection_id = ? AND token_id = ? LIMIT 1",
    );
    private selectCollectionById = db.prepare<[number, number]>(
        "SELECT collection_id, address, standard FROM collections WHERE chain_id = ? AND collection_id = ? LIMIT 1",
    );
    private upsertMetadata = db.prepare<{
        chainId: number;
        collectionId: number;
        contract: string;
        tokenId: string;
        uri: string | null;
        name: string | null;
        description: string | null;
        image: string | null;
        animationUrl: string | null;
        externalUrl: string | null;
        attributesJson: string | null;
        rawJson: string | null;
        blockNumber: number | null;
        blockHash: string | null;
        blockTimestamp: number | null;
        txHash: string | null;
        logIndex: number | null;
    }>(
        "INSERT INTO token_metadata " +
            "(chain_id, collection_id, contract_address, token_id, uri, name, description, image, animation_url, external_url, attributes_json, raw_json, block_number, block_hash, block_timestamp, tx_hash, log_index) " +
            "VALUES (@chainId, @collectionId, @contract, @tokenId, @uri, @name, @description, @image, @animationUrl, @externalUrl, @attributesJson, @rawJson, @blockNumber, @blockHash, @blockTimestamp, @txHash, @logIndex) " +
            "ON CONFLICT(chain_id, collection_id, token_id) DO UPDATE SET " +
            "uri = excluded.uri, name = excluded.name, description = excluded.description, image = excluded.image, " +
            "animation_url = excluded.animation_url, external_url = excluded.external_url, attributes_json = excluded.attributes_json, " +
            "raw_json = excluded.raw_json, block_number = excluded.block_number, block_hash = excluded.block_hash, " +
            "block_timestamp = excluded.block_timestamp, tx_hash = excluded.tx_hash, log_index = excluded.log_index, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private upsertToken = db.prepare<{
        chainId: number;
        collectionId: number;
        contract: string;
        tokenId: string;
        recordKind: string;
    }>(
        "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id, record_kind, record_source_key) " +
            "VALUES (@chainId, @collectionId, @contract, @tokenId, @recordKind, NULL) " +
            "ON CONFLICT(chain_id, collection_id, token_id) DO UPDATE SET " +
            "contract_address = excluded.contract_address, " +
            "record_kind = excluded.record_kind, " +
            "record_source_key = excluded.record_source_key, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private tokenAttributes = new SqliteTokenAttributeWriter();

    constructor(
        private readonly debugPayloads: DebugPayloadPersistenceConfig = getDefaultDebugPayloadPersistenceConfig(),
    ) {}

    *candidates(context: DomainSyncContext): Iterable<MetadataCandidate> {
        // Close each bounded reader before the caller performs RPC and writes on this connection.
        let after: [number, string, string] = [-1, "", ""];
        const pageSize = 128;
        const select = db.prepare(
            "SELECT collection_id,contract_address AS contract,token_id,kind,block_number,block_hash,block_timestamp,tx_hash,log_index FROM (SELECT e.*,ROW_NUMBER() OVER(PARTITION BY e.collection_id,e.token_id,e.kind ORDER BY e.block_number,e.log_index) rn FROM nft_transfer_events e JOIN collections c ON c.chain_id=e.chain_id AND c.collection_id=e.collection_id WHERE e.chain_id=? AND e.block_number>=? AND e.block_number<=? AND (? IS NULL OR e.collection_id=?) AND (e.collection_id,e.token_id,e.kind)>(?,?,?) AND c.bootstrap_anchor_block IS NOT NULL AND e.block_number>c.bootstrap_anchor_block) WHERE rn=1 ORDER BY collection_id,token_id,kind LIMIT ?",
        );
        while (true) {
            const rows = select.all(
                context.chainId,
                context.fromBlock,
                context.toBlock,
                context.collectionId,
                context.collectionId,
                ...after,
                pageSize,
            ) as TokenRow[];
            for (const row of rows) {
                after = [row.collection_id, row.token_id, row.kind];
                yield {
                    chainId: context.chainId,
                    collectionId: row.collection_id,
                    contract: row.contract.toLowerCase(),
                    tokenId: row.token_id,
                    standard: row.kind,
                    attribution: {
                        blockNumber: row.block_number,
                        blockHash: row.block_hash,
                        blockTimestamp: row.block_timestamp,
                        txHash: row.tx_hash,
                        logIndex: row.log_index,
                    },
                };
            }
            if (rows.length < pageSize) return;
        }
    }

    target(
        chainId: number,
        collectionId: number,
        tokenId: string,
    ): MetadataTarget | null {
        const row = this.selectCollectionById.get(chainId, collectionId) as
            | CollectionMetadataContextRow
            | undefined;
        return row
            ? {
                  chainId,
                  collectionId,
                  tokenId,
                  contract: row.address.toLowerCase(),
                  standard: row.standard,
              }
            : null;
    }

    hasMetadata(target: MetadataTarget): boolean {
        return Boolean(
            (
                this.selectMetadata.get(
                    target.chainId,
                    target.collectionId,
                    target.tokenId,
                ) as MetadataRow | undefined
            )?.present,
        );
    }

    private status(target: MetadataTarget): string | null {
        const row = db
            .prepare(
                "SELECT status FROM collections WHERE chain_id=? AND collection_id=? AND address=?",
            )
            .get(target.chainId, target.collectionId, target.contract) as
            | { status: string }
            | undefined;
        return row?.status ?? null;
    }

    private balance(target: MetadataTarget): MetadataAttribution | null {
        const row = db
            .prepare(
                "SELECT last_block_number AS blockNumber,last_block_hash AS blockHash,last_block_timestamp AS blockTimestamp,last_tx_hash AS txHash,last_log_index AS logIndex FROM nft_balances WHERE chain_id=? AND collection_id=? AND token_id=? AND amount!='0' AND substr(amount,1,1)!='-' ORDER BY last_block_number DESC,last_log_index DESC LIMIT 1",
            )
            .get(target.chainId, target.collectionId, target.tokenId) as
            | MetadataAttribution
            | undefined;
        return row ?? null;
    }

    private burned(target: MetadataTarget): boolean {
        // An ERC1155 transfer/balance subset cannot prove extinction of its token ID.
        if (target.standard !== COLLECTION_STANDARD.Erc721) return false;
        if (this.balance(target)) return false;
        const row = db
            .prepare(
                "SELECT to_address FROM nft_transfer_events WHERE chain_id=? AND collection_id=? AND token_id=? ORDER BY block_number DESC,log_index DESC LIMIT 1",
            )
            .get(target.chainId, target.collectionId, target.tokenId) as
            | { to_address: string }
            | undefined;
        return row?.to_address === zeroAddress;
    }

    private observed(target: MetadataTarget): boolean {
        return Boolean(
            db
                .prepare(
                    "SELECT 1 FROM nft_transfer_events WHERE chain_id=? AND collection_id=? AND token_id=? LIMIT 1",
                )
                .get(target.chainId, target.collectionId, target.tokenId),
        );
    }

    begin(
        target: MetadataTarget,
        options: MetadataFetchOptions,
        now: number,
        attribution?: MetadataAttribution,
    ): MetadataAttempt | null {
        return db.writeTransaction(() => {
            const status = this.status(target);
            if (!status || this.burned(target)) return null;
            if (
                status === COLLECTION_STATUS.Paused ||
                status === COLLECTION_STATUS.Disabled
            ) {
                db.prepare(
                    "INSERT INTO metadata_pending(chain_id,collection_id,token_id,options_json,attempts,first_pending_at,due_at,reason) VALUES(?,?,?,?,0,?,?,?) ON CONFLICT(chain_id,collection_id,token_id) DO UPDATE SET options_json=excluded.options_json,due_at=excluded.due_at,reason=excluded.reason,lease_owner=NULL",
                ).run(
                    target.chainId,
                    target.collectionId,
                    target.tokenId,
                    JSON.stringify(options),
                    now,
                    now + POLICY.retryBaseMs,
                    REASON.Deferred,
                );
                return null;
            }
            const owner = randomUUID();
            db.prepare(
                "INSERT INTO metadata_pending(chain_id,collection_id,token_id,options_json,attempts,first_pending_at,last_attempt_at,due_at,reason,lease_owner) VALUES(?,?,?,?,1,?,?,?,?,?) ON CONFLICT(chain_id,collection_id,token_id) DO UPDATE SET options_json=excluded.options_json,attempts=metadata_pending.attempts+1,last_attempt_at=excluded.last_attempt_at,due_at=excluded.due_at,reason=excluded.reason,lease_owner=excluded.lease_owner",
            ).run(
                target.chainId,
                target.collectionId,
                target.tokenId,
                JSON.stringify(options),
                now,
                now,
                now + POLICY.leaseMs,
                REASON.Fetching,
                owner,
            );
            const row = this.pending(target)!;
            return {
                target,
                owner,
                attempts: row.attempts,
                failures: row.failures,
                options,
                checkpoint: captureChainSyncCheckpoint(target.chainId).revision,
                retry: false,
                attribution,
            };
        })();
    }

    private pending(target: MetadataTarget): PendingRow | undefined {
        return db
            .prepare(
                "SELECT * FROM metadata_pending WHERE chain_id=? AND collection_id=? AND token_id=?",
            )
            .get(target.chainId, target.collectionId, target.tokenId) as
            | PendingRow
            | undefined;
    }

    private remove(attempt: MetadataAttempt): void {
        db.prepare(
            "DELETE FROM metadata_pending WHERE chain_id=? AND collection_id=? AND token_id=? AND lease_owner=?",
        ).run(
            attempt.target.chainId,
            attempt.target.collectionId,
            attempt.target.tokenId,
            attempt.owner,
        );
    }

    claimDue(chainId: number, now: number): MetadataAttempt | null {
        const result = db.writeTransaction(() => {
            // Round-robin live collections; each due lookup uses the per-collection index.
            const choose = (after: number) =>
                db
                    .prepare(
                        "SELECT c.collection_id FROM collections c WHERE c.chain_id=? AND c.status=? AND c.collection_id>? AND EXISTS(SELECT 1 FROM metadata_pending p WHERE p.chain_id=c.chain_id AND p.collection_id=c.collection_id AND p.due_at<=?) ORDER BY c.collection_id LIMIT 1",
                    )
                    .get(chainId, COLLECTION_STATUS.Live, after, now) as
                    | { collection_id: number }
                    | undefined;
            const collection = choose(this.collectionCursor) ?? choose(0);
            if (!collection)
                return { attempt: null, cursor: this.collectionCursor };
            const cursor = collection.collection_id;
            // Obsolete rows are removed in bounded pages, without RPC or a whole-table sweep.
            const rows = db
                .prepare(
                    "SELECT * FROM metadata_pending WHERE chain_id=? AND collection_id=? AND due_at<=? ORDER BY due_at,token_id LIMIT ?",
                )
                .all(
                    chainId,
                    collection.collection_id,
                    now,
                    POLICY.obsoletePageSize,
                ) as PendingRow[];
            for (const row of rows) {
                const target = this.target(
                    chainId,
                    row.collection_id,
                    row.token_id,
                )!;
                const attribution = this.balance(target);
                if (!attribution) {
                    if (this.burned(target))
                        db.prepare(
                            "DELETE FROM metadata_pending WHERE chain_id=? AND collection_id=? AND token_id=?",
                        ).run(chainId, row.collection_id, row.token_id);
                    else
                        db.prepare(
                            "UPDATE metadata_pending SET reason=?,due_at=?,lease_owner=NULL WHERE chain_id=? AND collection_id=? AND token_id=?",
                        ).run(
                            REASON.AwaitingOwnership,
                            now + POLICY.retryBaseMs,
                            chainId,
                            row.collection_id,
                            row.token_id,
                        );
                    continue;
                }
                const owner = randomUUID();
                db.prepare(
                    "UPDATE metadata_pending SET attempts=attempts+1,last_attempt_at=?,due_at=?,lease_owner=?,reason=? WHERE chain_id=? AND collection_id=? AND token_id=?",
                ).run(
                    now,
                    now + POLICY.leaseMs,
                    owner,
                    REASON.Fetching,
                    chainId,
                    row.collection_id,
                    row.token_id,
                );
                return {
                    cursor,
                    attempt: {
                        target,
                        owner,
                        attempts: row.attempts + 1,
                        failures: row.failures,
                        options: JSON.parse(
                            row.options_json,
                        ) as MetadataFetchOptions,
                        checkpoint:
                            captureChainSyncCheckpoint(chainId).revision,
                        retry: true,
                        attribution,
                    },
                };
            }
            return { attempt: null, cursor };
        })();
        // Failed/replayed writers must not advance process-local traversal state.
        this.collectionCursor = result.cursor;
        return result.attempt;
    }

    renew(attempt: MetadataAttempt, now: number): void {
        db.prepare(
            "UPDATE metadata_pending SET due_at=? WHERE chain_id=? AND collection_id=? AND token_id=? AND lease_owner=? AND due_at>?",
        ).run(
            now + POLICY.leaseMs,
            attempt.target.chainId,
            attempt.target.collectionId,
            attempt.target.tokenId,
            attempt.owner,
            now,
        );
    }

    defer(
        attempt: MetadataAttempt,
        reason: MetadataPendingReason,
        now: number,
        delayMs = metadataRetryDelay(attempt),
    ): void {
        db.writeTransaction(() => {
            if (this.pending(attempt.target)?.lease_owner !== attempt.owner)
                return;
            const status = this.status(attempt.target);
            if (
                !status ||
                this.burned(attempt.target) ||
                (status === COLLECTION_STATUS.Live &&
                    !attempt.retry &&
                    !this.balance(attempt.target) &&
                    !this.hasMetadata(attempt.target) &&
                    !this.observed(attempt.target))
            ) {
                this.remove(attempt);
                return;
            }
            db.prepare(
                "UPDATE metadata_pending SET reason=?,due_at=?,lease_owner=NULL,failures=failures+? WHERE chain_id=? AND collection_id=? AND token_id=? AND lease_owner=?",
            ).run(
                reason,
                now + Math.max(1, delayMs),
                isMetadataHostingFailure(reason) ? 1 : 0,
                attempt.target.chainId,
                attempt.target.collectionId,
                attempt.target.tokenId,
                attempt.owner,
            );
        })();
    }

    complete(
        attempt: MetadataAttempt,
        metadata: TokenMetadata,
        ready: boolean,
        now: number,
        afterWrite?: (updated: MetadataUpdatedToken) => void,
    ): MetadataUpdatedToken | null {
        return db.writeTransaction(() => {
            const row = this.pending(attempt.target);
            if (!row || row.lease_owner !== attempt.owner || row.due_at <= now)
                return null;
            if (
                captureChainSyncCheckpoint(attempt.target.chainId).revision !==
                attempt.checkpoint
            ) {
                this.defer(attempt, REASON.Interrupted, now);
                return null;
            }
            const status = this.status(attempt.target);
            if (!status || this.burned(attempt.target)) {
                this.remove(attempt);
                return null;
            }
            if (attempt.retry && !this.balance(attempt.target)) {
                this.defer(
                    attempt,
                    REASON.AwaitingOwnership,
                    now,
                    POLICY.retryBaseMs,
                );
                return null;
            }
            if (
                status === COLLECTION_STATUS.Paused ||
                status === COLLECTION_STATUS.Disabled
            ) {
                this.defer(attempt, REASON.Deferred, now);
                return null;
            }
            let updated: MetadataUpdatedToken | null = null;
            // Never replace a previous observation with an incomplete response.
            if (ready || !this.hasMetadata(attempt.target)) {
                const t = attempt.target;
                this.persistMetadata(
                    t.chainId,
                    t.collectionId,
                    t.contract,
                    t.tokenId,
                    metadata,
                    attempt.attribution,
                );
                updated = {
                    collectionId: t.collectionId,
                    contract: t.contract,
                    tokenId: t.tokenId,
                    image: metadata.image ?? null,
                };
                afterWrite?.(updated);
            }
            if (ready) this.remove(attempt);
            else this.defer(attempt, REASON.NotReady, now);
            return updated;
        })();
    }

    pendingSummary(
        chainId: number,
        now: number,
    ): { pending: number; oldestAgeMs: number } {
        const row = db
            .prepare(
                "SELECT count(*) AS pending,min(first_pending_at) AS oldest FROM metadata_pending WHERE chain_id=?",
            )
            .get(chainId) as { pending: number; oldest: number | null };
        return {
            pending: row.pending,
            oldestAgeMs:
                row.oldest === null ? 0 : Math.max(0, now - row.oldest),
        };
    }

    private persistMetadata(
        chainId: number,
        collectionId: number,
        contract: string,
        tokenId: string,
        metadata: TokenMetadata,
        attribution?: MetadataAttribution,
    ): void {
        const normalizedAttributes = normalizeUniqueAttributeList(
            (metadata.attributes ?? []).map((attribute) => ({
                key: attribute.traitType,
                value: attribute.value,
            })),
        );

        const persist = db.writeTransaction(() => {
            // Persist token identity first so future FK constraints can safely
            // reference tokens before metadata/attributes are written.
            this.upsertToken.run({
                chainId,
                collectionId,
                contract,
                tokenId,
                recordKind: TOKEN_RECORD_KIND.Canonical,
            });

            this.upsertMetadata.run({
                chainId,
                collectionId,
                contract,
                tokenId,
                uri: this.debugPayloads.persistRawDebugPayloads
                    ? metadata.uri
                    : null,
                name: metadata.name ?? null,
                description: metadata.description ?? null,
                image: metadata.image ?? null,
                animationUrl: metadata.animationUrl ?? null,
                externalUrl: metadata.externalUrl ?? null,
                attributesJson: this.debugPayloads.persistRawDebugPayloads
                    ? JSON.stringify(metadata.attributes ?? [])
                    : null,
                rawJson: this.debugPayloads.persistRawDebugPayloads
                    ? metadata.rawJson
                    : null,
                blockNumber: attribution?.blockNumber ?? null,
                blockHash: attribution?.blockHash ?? null,
                blockTimestamp: attribution?.blockTimestamp ?? null,
                txHash: attribution?.txHash ?? null,
                logIndex: attribution?.logIndex ?? null,
            });

            // Replace only canonical metadata links so extension-owned traits survive refreshes.
            this.tokenAttributes.replaceTokenAttributes({
                chainId,
                collectionId,
                contractAddress: contract,
                tokenId,
                sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
                sourceKey: TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
                attributes: normalizedAttributes,
            });
        });

        persist();
    }
}
