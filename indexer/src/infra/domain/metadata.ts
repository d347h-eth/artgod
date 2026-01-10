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
};

type MetadataRow = { uri: string };

export class SqliteMetadataDomain implements MetadataDomainPort {
    private selectTokens = db.prepare<
        [number, number, number]
    >(
        "SELECT contract, token_id, kind FROM nft_transfer_events " +
            "WHERE chain_id = ? AND block_number >= ? AND block_number <= ? " +
            "GROUP BY contract, token_id, kind",
    );
    private selectMetadata = db.prepare<
        [number, string, string]
    >(
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
        ]
    >(
        "INSERT INTO token_metadata " +
            "(chain_id, contract, token_id, uri, name, description, image, animation_url, external_url, attributes_json, raw_json) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(chain_id, contract, token_id) DO UPDATE SET " +
            "uri = excluded.uri, name = excluded.name, description = excluded.description, image = excluded.image, " +
            "animation_url = excluded.animation_url, external_url = excluded.external_url, attributes_json = excluded.attributes_json, " +
            "raw_json = excluded.raw_json, updated_at = CURRENT_TIMESTAMP",
    );

    constructor(
        private resolver: TokenUriResolverPort,
        private fetcher: MetadataFetcherPort,
    ) {}

    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        const { chainId, fromBlock, toBlock } = context;
        if (fromBlock > toBlock) return;

        const rows = this.selectTokens.all(
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
            this.persistMetadata(chainId, contract, tokenId, metadata);
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
        const row = this.selectMetadata.get(
            chainId,
            contract,
            tokenId,
        ) as MetadataRow | undefined;
        return Boolean(row?.uri);
    }

    private persistMetadata(
        chainId: number,
        contract: string,
        tokenId: string,
        metadata: TokenMetadata,
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
        );
    }
}
