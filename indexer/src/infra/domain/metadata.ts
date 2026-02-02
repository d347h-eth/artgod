import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import type { TokenMetadata, TokenStandard } from "../../domain/metadata.js";
import { normalizeUniqueAttributeList } from "../../domain/attributes.js";
import type {
    DomainSyncContext,
    MetadataDomainPort,
} from "../../ports/domain-handlers.js";
import type {
    MetadataFetcherPort,
    TokenUriResolverPort,
} from "../../ports/metadata.js";

type TokenRow = {
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

export class SqliteMetadataDomain implements MetadataDomainPort {
    // Select the first transfer per token in-range (used for metadata attribution).
    private selectFirstTransferPerToken = db.prepare<[number, number, number]>(
        "SELECT contract_address AS contract, token_id, kind, block_number, block_hash, block_timestamp, tx_hash, log_index FROM (" +
            "SELECT contract_address, token_id, kind, block_number, block_hash, block_timestamp, tx_hash, log_index, " +
            "ROW_NUMBER() OVER (PARTITION BY contract_address, token_id, kind ORDER BY block_number ASC, log_index ASC) AS rn " +
            "FROM nft_transfer_events WHERE chain_id = ? AND block_number >= ? AND block_number <= ? " +
            ") WHERE rn = 1",
    );
    private selectMetadata = db.prepare<[number, string, string]>(
        "SELECT uri FROM token_metadata WHERE chain_id = ? AND contract_address = ? AND token_id = ? LIMIT 1",
    );
    private upsertMetadata = db.prepare<
        [
            number,
            string,
            string,
            string,
            string | null,
            string | null,
            string | null,
            string | null,
            string | null,
            string,
            string,
            number | null,
            string | null,
            number | null,
            string | null,
            number | null,
        ]
    >(
        "INSERT INTO token_metadata " +
            "(chain_id, contract_address, token_id, uri, name, description, image, animation_url, external_url, attributes_json, raw_json, block_number, block_hash, block_timestamp, tx_hash, log_index) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, contract_address, token_id) DO UPDATE SET " +
            "uri = excluded.uri, name = excluded.name, description = excluded.description, image = excluded.image, " +
            "animation_url = excluded.animation_url, external_url = excluded.external_url, attributes_json = excluded.attributes_json, " +
            "raw_json = excluded.raw_json, block_number = excluded.block_number, block_hash = excluded.block_hash, " +
            "block_timestamp = excluded.block_timestamp, tx_hash = excluded.tx_hash, log_index = excluded.log_index, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private upsertToken = db.prepare<[number, string, string]>(
        "INSERT INTO tokens (chain_id, contract_address, token_id) VALUES (?, ?, ?) " +
            "ON CONFLICT(chain_id, contract_address, token_id) DO UPDATE SET " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private deleteTokenAttributes = db.prepare<[number, string, string]>(
        "DELETE FROM token_attributes WHERE chain_id = ? AND contract_address = ? AND token_id = ?",
    );
    private insertAttributeKey = db.prepare<[number, string, string]>(
        "INSERT OR IGNORE INTO attribute_keys (chain_id, contract_address, key) VALUES (?, ?, ?)",
    );
    private selectAttributeKeyId = db.prepare<[number, string, string]>(
        "SELECT id FROM attribute_keys WHERE chain_id = ? AND contract_address = ? AND key = ?",
    );
    private insertAttribute = db.prepare<[number, string, number, string]>(
        "INSERT OR IGNORE INTO attributes (chain_id, contract_address, attribute_key_id, value) VALUES (?, ?, ?, ?)",
    );
    private selectAttributeId = db.prepare<[number, string, number, string]>(
        "SELECT id FROM attributes WHERE chain_id = ? AND contract_address = ? AND attribute_key_id = ? AND value = ?",
    );
    private insertTokenAttribute = db.prepare<[number, string, string, number]>(
        "INSERT OR IGNORE INTO token_attributes (chain_id, contract_address, token_id, attribute_id) " +
            "VALUES (?, ?, ?, ?)",
    );

    constructor(
        private resolver: TokenUriResolverPort,
        private fetcher: MetadataFetcherPort,
    ) {}

    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        const { chainId, fromBlock, toBlock } = context;
        if (fromBlock > toBlock) return;

        const rows = this.selectFirstTransferPerToken.all(
            chainId,
            fromBlock,
            toBlock,
        ) as TokenRow[];

        let fetched = 0;
        for (const row of rows) {
            const contract = row.contract.toLowerCase();
            const tokenId = row.token_id;
            if (this.hasMetadata(chainId, contract, tokenId)) {
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
                    contract,
                    tokenId,
                    uri,
                });
                continue;
            }
            this.persistMetadata(chainId, contract, tokenId, metadata, row);
            fetched += 1;
        }

        logger.debug("Metadata domain sync applied", {
            component: "MetadataDomain",
            action: "handleDomainSync",
            chainId,
            fromBlock,
            toBlock,
            tokens: rows.length,
            fetched,
        });
    }

    private hasMetadata(
        chainId: number,
        contract: string,
        tokenId: string,
    ): boolean {
        const row = this.selectMetadata.get(chainId, contract, tokenId) as
            | MetadataRow
            | undefined;
        return Boolean(row?.uri);
    }

    private persistMetadata(
        chainId: number,
        contract: string,
        tokenId: string,
        metadata: TokenMetadata,
        attribution: TokenRow,
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
            this.upsertToken.run(chainId, contract, tokenId);

            this.upsertMetadata.run(
                chainId,
                contract,
                tokenId,
                metadata.uri,
                metadata.name ?? null,
                metadata.description ?? null,
                metadata.image ?? null,
                metadata.animationUrl ?? null,
                metadata.externalUrl ?? null,
                JSON.stringify(metadata.attributes ?? []),
                metadata.rawJson,
                attribution.block_number ?? null,
                attribution.block_hash ?? null,
                attribution.block_timestamp ?? null,
                attribution.tx_hash ?? null,
                attribution.log_index ?? null,
            );

            // Replace attribute links for this token on every metadata refresh.
            this.deleteTokenAttributes.run(chainId, contract, tokenId);

            for (const attribute of normalizedAttributes) {
                this.insertAttributeKey.run(chainId, contract, attribute.key);
                const keyRow = this.selectAttributeKeyId.get(
                    chainId,
                    contract,
                    attribute.key,
                ) as { id: number } | undefined;
                if (!keyRow) continue;
                this.insertAttribute.run(
                    chainId,
                    contract,
                    keyRow.id,
                    attribute.value,
                );
                const attributeRow = this.selectAttributeId.get(
                    chainId,
                    contract,
                    keyRow.id,
                    attribute.value,
                ) as { id: number } | undefined;
                if (!attributeRow) continue;
                this.insertTokenAttribute.run(
                    chainId,
                    contract,
                    tokenId,
                    attributeRow.id,
                );
            }
        });

        persist();
    }
}
