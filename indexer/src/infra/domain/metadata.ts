import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import type { TokenMetadata, TokenStandard } from "../../domain/metadata.js";
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
        "SELECT contract, token_id, kind, block_number, block_hash, block_timestamp, tx_hash, log_index FROM (" +
            "SELECT contract, token_id, kind, block_number, block_hash, block_timestamp, tx_hash, log_index, " +
            "ROW_NUMBER() OVER (PARTITION BY contract, token_id, kind ORDER BY block_number ASC, log_index ASC) AS rn " +
            "FROM nft_transfer_events WHERE chain_id = ? AND block_number >= ? AND block_number <= ? " +
            ") WHERE rn = 1",
    );
    private selectMetadata = db.prepare<[number, string, string]>(
        "SELECT uri FROM token_metadata WHERE chain_id = ? AND contract = ? AND token_id = ? LIMIT 1",
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
            "(chain_id, contract, token_id, uri, name, description, image, animation_url, external_url, attributes_json, raw_json, block_number, block_hash, block_timestamp, tx_hash, log_index) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, contract, token_id) DO UPDATE SET " +
            "uri = excluded.uri, name = excluded.name, description = excluded.description, image = excluded.image, " +
            "animation_url = excluded.animation_url, external_url = excluded.external_url, attributes_json = excluded.attributes_json, " +
            "raw_json = excluded.raw_json, block_number = excluded.block_number, block_hash = excluded.block_hash, " +
            "block_timestamp = excluded.block_timestamp, tx_hash = excluded.tx_hash, log_index = excluded.log_index, " +
            "updated_at = CURRENT_TIMESTAMP",
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
    }
}
