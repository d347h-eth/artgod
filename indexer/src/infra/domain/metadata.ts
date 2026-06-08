import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { DOMAIN_SYNC_PROJECTION } from "../../domain/domain-jobs.js";
import type {
    MetadataDomainSyncResult,
    MetadataRefreshResult,
    TokenMetadata,
    TokenStandard,
} from "../../domain/metadata.js";
import { normalizeUniqueAttributeList } from "../../domain/attributes.js";
import type {
    DomainSyncContext,
    MetadataDomainPort,
} from "../../ports/domain-handlers.js";
import type { MetadataRefreshPayload } from "../../domain/domain-jobs.js";
import type {
    MetadataFetcherPort,
    TokenUriResolverPort,
} from "../../ports/metadata.js";

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

type MetadataRow = { uri: string };
type CollectionMetadataContextRow = {
    collection_id: number;
    address: string;
    standard: TokenStandard;
};

type MetadataAttribution = {
    block_number?: number | null;
    block_hash?: string | null;
    block_timestamp?: number | null;
    tx_hash?: string | null;
    log_index?: number | null;
};

export class SqliteMetadataDomain implements MetadataDomainPort {
    // Select the first transfer per token in-range (used for metadata attribution).
    private selectFirstTransferPerToken = db.prepare<[number, number, number]>(
        "SELECT collection_id, contract_address AS contract, token_id, kind, block_number, block_hash, block_timestamp, tx_hash, log_index FROM (" +
            "SELECT e.collection_id, e.contract_address, e.token_id, e.kind, e.block_number, e.block_hash, e.block_timestamp, e.tx_hash, e.log_index, " +
            "ROW_NUMBER() OVER (PARTITION BY e.collection_id, e.token_id, e.kind ORDER BY e.block_number ASC, e.log_index ASC) AS rn " +
            "FROM nft_transfer_events e " +
            "JOIN collections c ON c.chain_id = e.chain_id AND c.collection_id = e.collection_id " +
            "WHERE e.chain_id = ? AND e.block_number >= ? AND e.block_number <= ? " +
            "AND c.bootstrap_anchor_block IS NOT NULL AND e.block_number > c.bootstrap_anchor_block " +
            ") WHERE rn = 1",
    );
    private selectFirstTransferPerTokenForCollection = db.prepare<
        [number, number, number, number]
    >(
        "SELECT collection_id, contract_address AS contract, token_id, kind, block_number, block_hash, block_timestamp, tx_hash, log_index FROM (" +
            "SELECT e.collection_id, e.contract_address, e.token_id, e.kind, e.block_number, e.block_hash, e.block_timestamp, e.tx_hash, e.log_index, " +
            "ROW_NUMBER() OVER (PARTITION BY e.collection_id, e.token_id, e.kind ORDER BY e.block_number ASC, e.log_index ASC) AS rn " +
            "FROM nft_transfer_events e " +
            "JOIN collections c ON c.chain_id = e.chain_id AND c.collection_id = e.collection_id " +
            "WHERE e.chain_id = ? AND e.block_number >= ? AND e.block_number <= ? " +
            "AND e.collection_id = ? " +
            "AND c.bootstrap_anchor_block IS NOT NULL AND e.block_number > c.bootstrap_anchor_block " +
            ") WHERE rn = 1",
    );
    private selectMetadata = db.prepare<[number, number, string]>(
        "SELECT uri FROM token_metadata WHERE chain_id = ? AND collection_id = ? AND token_id = ? LIMIT 1",
    );
    private selectCollectionById = db.prepare<[number, number]>(
        "SELECT collection_id, address, standard FROM collections WHERE chain_id = ? AND collection_id = ? LIMIT 1",
    );
    private upsertMetadata = db.prepare<{
        chainId: number;
        collectionId: number;
        contract: string;
        tokenId: string;
        uri: string;
        name: string | null;
        description: string | null;
        image: string | null;
        animationUrl: string | null;
        externalUrl: string | null;
        attributesJson: string;
        rawJson: string;
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
    private upsertToken = db.prepare<[number, number, string, string]>(
        "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, collection_id, token_id) DO UPDATE SET " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private deleteTokenAttributes = db.prepare<[number, number, string]>(
        "DELETE FROM token_attributes WHERE chain_id = ? AND collection_id = ? AND token_id = ?",
    );
    private insertAttributeKey = db.prepare<[number, number, string, string]>(
        "INSERT OR IGNORE INTO attribute_keys (chain_id, collection_id, contract_address, key) VALUES (?, ?, ?, ?)",
    );
    private selectAttributeKeyId = db.prepare<[number, number, string]>(
        "SELECT id FROM attribute_keys WHERE chain_id = ? AND collection_id = ? AND key = ?",
    );
    private insertAttribute = db.prepare<
        [number, number, string, number, string]
    >(
        "INSERT OR IGNORE INTO attributes (chain_id, collection_id, contract_address, attribute_key_id, value) VALUES (?, ?, ?, ?, ?)",
    );
    private selectAttributeId = db.prepare<[number, number, number, string]>(
        "SELECT id FROM attributes WHERE chain_id = ? AND collection_id = ? AND attribute_key_id = ? AND value = ?",
    );
    private insertTokenAttribute = db.prepare<
        [number, number, string, string, number]
    >(
        "INSERT OR IGNORE INTO token_attributes (chain_id, collection_id, contract_address, token_id, attribute_id) " +
            "VALUES (?, ?, ?, ?, ?)",
    );

    constructor(
        private resolver: TokenUriResolverPort,
        private fetcher: MetadataFetcherPort,
    ) {}

    async handleDomainSync(
        context: DomainSyncContext,
    ): Promise<MetadataDomainSyncResult> {
        const { chainId, fromBlock, toBlock } = context;
        if (fromBlock > toBlock) {
            return {
                contracts: [],
                updatedTokens: [],
            };
        }
        if (context.projection === DOMAIN_SYNC_PROJECTION.FactsOnly) {
            logger.debug("Metadata domain sync skipped for facts-only projection", {
                component: "MetadataDomain",
                action: "handleDomainSync",
                chainId,
                collectionId: context.collectionId,
                fromBlock,
                toBlock,
                mode: context.mode,
            });
            return {
                contracts: [],
                updatedTokens: [],
            };
        }

        const rows =
            context.collectionId === null
                ? (this.selectFirstTransferPerToken.all(
                      chainId,
                      fromBlock,
                      toBlock,
                  ) as TokenRow[])
                : (this.selectFirstTransferPerTokenForCollection.all(
                      chainId,
                      fromBlock,
                      toBlock,
                      context.collectionId,
                  ) as TokenRow[]);
        const contracts = new Set<string>();
        const collectionIds = new Set<number>();
        const updatedTokens: MetadataDomainSyncResult["updatedTokens"] = [];
        for (const row of rows) {
            contracts.add(row.contract.toLowerCase());
            collectionIds.add(row.collection_id);
        }

        let fetched = 0;
        for (const row of rows) {
            const contract = row.contract.toLowerCase();
            const tokenId = row.token_id;
            if (this.hasMetadata(chainId, row.collection_id, tokenId)) {
                continue;
            }
            const uri = await this.resolver.resolveTokenUri(
                contract,
                tokenId,
                row.kind,
            );
            if (!uri) {
                logger.debug("Metadata URI unavailable", {
                    component: "MetadataDomain",
                    action: "handleDomainSync",
                    chainId,
                    collectionId: row.collection_id,
                    contract,
                    tokenId,
                });
                continue;
            }
            const metadata = await this.fetcher.fetchMetadata(uri);
            if (!metadata) {
                logger.debug("Metadata fetch failed", {
                    component: "MetadataDomain",
                    action: "handleDomainSync",
                    chainId,
                    collectionId: row.collection_id,
                    contract,
                    tokenId,
                    uri,
                });
                continue;
            }
            this.persistMetadata(
                chainId,
                row.collection_id,
                contract,
                tokenId,
                metadata,
                row,
            );
            updatedTokens.push({
                collectionId: row.collection_id,
                contract,
                tokenId,
                image: metadata.image ?? null,
            });
            fetched += 1;
        }

        logger.debug("Metadata domain sync applied", {
            component: "MetadataDomain",
            action: "handleDomainSync",
            chainId,
            fromBlock,
            toBlock,
            collectionIds: Array.from(collectionIds),
            tokens: rows.length,
            fetched,
        });
        return {
            contracts: Array.from(contracts),
            updatedTokens,
        };
    }

    async handleMetadataRefresh(
        payload: MetadataRefreshPayload,
    ): Promise<MetadataRefreshResult> {
        const { chainId } = payload;
        const tokenId = payload.tokenId;
        const collection = this.resolveCollectionMetadataContext(
            chainId,
            payload.collectionId,
        );
        if (!collection) {
            logger.debug("Metadata refresh skipped (missing collection)", {
                component: "MetadataDomain",
                action: "handleMetadataRefresh",
                chainId,
                collectionId: payload.collectionId,
                tokenId,
            });
            return null;
        }

        const contract = collection.address.toLowerCase();
        let uri = payload.metadataUrl ?? null;
        const tokenStandard = payload.standard ?? collection.standard;
        const blockNumber = payload.blockNumber;
        if (!uri) {
            const standard = tokenStandard;
            if (!standard) return null;
            uri = await this.resolver.resolveTokenUri(
                contract,
                tokenId,
                standard,
                blockNumber,
            );
        }
        if (!uri) {
            logger.debug("Metadata refresh URI unavailable", {
                component: "MetadataDomain",
                action: "handleMetadataRefresh",
                chainId,
                collectionId: payload.collectionId,
                contract,
                tokenId,
            });
            return null;
        }

        const metadata = await this.fetcher.fetchMetadata(uri);
        if (!metadata) {
            logger.debug("Metadata refresh fetch failed", {
                component: "MetadataDomain",
                action: "handleMetadataRefresh",
                chainId,
                collectionId: payload.collectionId,
                contract,
                tokenId,
                uri,
            });
            return null;
        }

        this.persistMetadata(
            chainId,
            collection.collection_id,
            contract,
            tokenId,
            metadata,
            {
                block_number: payload.blockNumber ?? null,
                block_hash: payload.blockHash ?? null,
                block_timestamp: payload.blockTimestamp ?? null,
                tx_hash: null,
                log_index: null,
            },
        );

        logger.debug("Metadata refresh applied", {
            component: "MetadataDomain",
            action: "handleMetadataRefresh",
            chainId,
            collectionId: collection.collection_id,
            contract,
            tokenId,
            reason: payload.reason,
        });
        return {
            collectionId: collection.collection_id,
            contract,
            tokenId,
            image: metadata.image ?? null,
        };
    }

    private resolveCollectionMetadataContext(
        chainId: number,
        collectionId: number,
    ): CollectionMetadataContextRow | null {
        const row = this.selectCollectionById.get(chainId, collectionId) as
            | CollectionMetadataContextRow
            | undefined;
        if (row) {
            return row;
        }
        logger.debug("Metadata refresh skipped (missing collection)", {
            component: "MetadataDomain",
            action: "handleMetadataRefresh",
            chainId,
            collectionId,
        });
        return null;
    }

    private hasMetadata(
        chainId: number,
        collectionId: number,
        tokenId: string,
    ): boolean {
        const row = this.selectMetadata.get(chainId, collectionId, tokenId) as
            | MetadataRow
            | undefined;
        return Boolean(row?.uri);
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

        const persist = db.raw.transaction(() => {
            // Persist token identity first so future FK constraints can safely
            // reference tokens before metadata/attributes are written.
            this.upsertToken.run(chainId, collectionId, contract, tokenId);

            this.upsertMetadata.run({
                chainId,
                collectionId,
                contract,
                tokenId,
                uri: metadata.uri,
                name: metadata.name ?? null,
                description: metadata.description ?? null,
                image: metadata.image ?? null,
                animationUrl: metadata.animationUrl ?? null,
                externalUrl: metadata.externalUrl ?? null,
                attributesJson: JSON.stringify(metadata.attributes ?? []),
                rawJson: metadata.rawJson,
                blockNumber: attribution?.block_number ?? null,
                blockHash: attribution?.block_hash ?? null,
                blockTimestamp: attribution?.block_timestamp ?? null,
                txHash: attribution?.tx_hash ?? null,
                logIndex: attribution?.log_index ?? null,
            });

            // Replace attribute links for this token on every metadata refresh.
            this.deleteTokenAttributes.run(chainId, collectionId, tokenId);

            for (const attribute of normalizedAttributes) {
                this.insertAttributeKey.run(
                    chainId,
                    collectionId,
                    contract,
                    attribute.key,
                );
                const keyRow = this.selectAttributeKeyId.get(
                    chainId,
                    collectionId,
                    attribute.key,
                ) as { id: number } | undefined;
                if (!keyRow) continue;
                this.insertAttribute.run(
                    chainId,
                    collectionId,
                    contract,
                    keyRow.id,
                    attribute.value,
                );
                const attributeRow = this.selectAttributeId.get(
                    chainId,
                    collectionId,
                    keyRow.id,
                    attribute.value,
                ) as { id: number } | undefined;
                if (!attributeRow) continue;
                this.insertTokenAttribute.run(
                    chainId,
                    collectionId,
                    contract,
                    tokenId,
                    attributeRow.id,
                );
            }
        });

        persist();
    }
}
