import { db } from "@artgod/shared/database";
import { biddingTraitsMatchToken } from "@artgod/shared/trading/offer-trait-criteria";
import { logger } from "@artgod/shared/utils";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "@artgod/shared/types/token-attributes";
import type {
    TokenSetRegistryPort,
    TokenSetRequest,
} from "../../ports/token-sets.js";
import type {
    TokenSetAttributeSchema,
    TokenSetSchema,
    TokenSetResolution,
} from "../../domain/token-sets.js";
import { TOKEN_SET_SCHEMA_KIND } from "../../domain/token-sets.js";
import {
    buildTokenSetId,
    generateMerkleRoot,
    generateSchemaHash,
    isSeaportTokenSetTokenId,
    normalizeSchema,
} from "../../application/token-sets/utils.js";

type AttributeIdRow = { id: number };
type TokenIdRow = { token_id: string };

export class SqliteTokenSetRegistry implements TokenSetRegistryPort {
    private insertTokenSet = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenSetId: string;
        schemaHash: string;
        schemaJson: string;
        contractAddress: string;
        attributeId: number | null;
        merkleRoot: string | null;
    }>(
        "INSERT INTO token_sets " +
            "(chain_id, collection_id, id, schema_hash, schema_json, contract_address, attribute_id, merkle_root) " +
            "VALUES (@chainId, @collectionId, @tokenSetId, @schemaHash, @schemaJson, @contractAddress, @attributeId, @merkleRoot) " +
            "ON CONFLICT(chain_id, collection_id, id, schema_hash) DO UPDATE SET " +
            "schema_json = excluded.schema_json, " +
            "contract_address = excluded.contract_address, " +
            "attribute_id = excluded.attribute_id, " +
            "merkle_root = excluded.merkle_root, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private insertTokenSetToken = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenSetId: string;
        tokenSetSchemaHash: string;
        contractAddress: string;
        tokenId: string;
    }>(
        "INSERT OR IGNORE INTO token_sets_tokens " +
            "(chain_id, collection_id, token_set_id, token_set_schema_hash, contract_address, token_id) " +
            "VALUES (@chainId, @collectionId, @tokenSetId, @tokenSetSchemaHash, @contractAddress, @tokenId)",
    );
    private selectAttributeKeyId = db.prepare<{
        chainId: number;
        collectionId: number;
        key: string;
    }>(
        "SELECT id FROM attribute_keys WHERE chain_id = @chainId AND collection_id = @collectionId AND key = @key",
    );
    private selectAttributeId = db.prepare<{
        chainId: number;
        collectionId: number;
        attributeKeyId: number;
        value: string;
    }>(
        "SELECT id FROM attributes WHERE chain_id = @chainId AND collection_id = @collectionId AND attribute_key_id = @attributeKeyId AND value = @value",
    );
    private selectCollectionTokenIds = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT DISTINCT token_id FROM nft_balances " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "ORDER BY token_id",
    );

    ensureTokenSet(request: TokenSetRequest): TokenSetResolution | null {
        const schema = normalizeSchema(request.schema);
        const schemaHash = generateSchemaHash(schema);
        const contractAddress = schema.data.collection.toLowerCase();
        const resolvedTokenIds =
            schema.kind === TOKEN_SET_SCHEMA_KIND.Attribute
                ? this.resolveTokensByAttributes(
                      request.chainId,
                      request.collectionId,
                      contractAddress,
                      schema,
                  )
                : this.resolveTokensByCollection(
                      request.chainId,
                      request.collectionId,
                  );
        // Seaport leaves must be onchain token ids; this defends collection sets and bad legacy rows.
        const tokenIds = resolvedTokenIds.filter(isSeaportTokenSetTokenId);

        let merkleRoot: string | null = null;
        if (tokenIds.length > 0) {
            merkleRoot = generateMerkleRoot(tokenIds);
        }

        if (!merkleRoot) {
            logger.warn("Token set resolution skipped (empty set)", {
                component: "TokenSetRegistry",
                action: "ensureTokenSet",
                chainId: request.chainId,
                contractAddress,
                kind: schema.kind,
            });
            return null;
        }

        const tokenSetId = buildTokenSetId(contractAddress, merkleRoot);
        const attributeId =
            schema.kind === TOKEN_SET_SCHEMA_KIND.Attribute &&
            schema.data.attributes.length === 1
                ? this.resolveSingleAttributeId(
                      request.chainId,
                      request.collectionId,
                      contractAddress,
                      schema,
                  )
                : null;

        this.insertTokenSet.run({
            chainId: request.chainId,
            collectionId: request.collectionId,
            tokenSetId,
            schemaHash,
            schemaJson: JSON.stringify(schema),
            contractAddress,
            attributeId,
            merkleRoot,
        });

        if (tokenIds.length > 0) {
            const insertTokens = db.writeTransaction(() => {
                for (const tokenId of tokenIds) {
                    this.insertTokenSetToken.run({
                        chainId: request.chainId,
                        collectionId: request.collectionId,
                        tokenSetId,
                        tokenSetSchemaHash: schemaHash,
                        contractAddress,
                        tokenId,
                    });
                }
            });
            insertTokens();
        }

        return {
            tokenSetId,
            schemaHash,
            merkleRoot,
            tokenCount: tokenIds.length,
        };
    }

    private resolveTokensByCollection(
        chainId: number,
        collectionId: number,
    ): string[] {
        const rows = this.selectCollectionTokenIds.all({
            chainId,
            collectionId,
        }) as TokenIdRow[];
        return rows.map((row) => row.token_id);
    }

    private resolveTokensByAttributes(
        chainId: number,
        collectionId: number,
        contractAddress: string,
        schema: TokenSetAttributeSchema,
    ): string[] {
        const attributes = schema.data.attributes;
        if (!attributes.length) return [];
        if (attributes.some((attribute) => attribute.value === undefined)) {
            // Numeric text needs the same strict decimal validation as token/offer matching.
            // Stream relevant canonical traits one token at a time instead of coercing text in SQL.
            return this.resolveTokensByNumericAttributes(
                chainId,
                collectionId,
                attributes,
            );
        }

        // AND semantics over canonical metadata traits; extension traits are browse-only here.
        const values: Record<string, string | number> = {
            chainId,
            collectionId,
            contractAddress,
            attributesCount: attributes.length,
            sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
            sourceKey: TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
        };
        const clauses = attributes.map((attribute, index) => {
            const key = `key${index}`;
            const value = `value${index}`;
            values[key] = attribute.key;
            values[value] = attribute.value!;
            return `(attribute_keys.key = @${key} AND attributes.value = @${value})`;
        });

        const sql =
            "SELECT token_attributes.token_id " +
            "FROM token_attributes " +
            "JOIN attributes ON token_attributes.attribute_id = attributes.id " +
            "JOIN attribute_keys ON attributes.attribute_key_id = attribute_keys.id " +
            "WHERE token_attributes.chain_id = @chainId " +
            "AND token_attributes.collection_id = @collectionId " +
            "AND token_attributes.source_kind = @sourceKind " +
            "AND token_attributes.source_key = @sourceKey " +
            "AND attributes.chain_id = @chainId " +
            "AND attributes.collection_id = @collectionId " +
            "AND attribute_keys.chain_id = @chainId " +
            "AND attribute_keys.collection_id = @collectionId " +
            `AND (${clauses.join(" OR ")}) ` +
            "GROUP BY token_attributes.token_id " +
            "HAVING COUNT(DISTINCT (attribute_keys.key || ':' || attributes.value)) = @attributesCount " +
            "ORDER BY token_attributes.token_id";

        const rows = db.prepare(sql).all(values) as TokenIdRow[];
        return rows.map((row) => row.token_id);
    }

    private resolveTokensByNumericAttributes(
        chainId: number,
        collectionId: number,
        attributes: TokenSetAttributeSchema["data"]["attributes"],
    ): string[] {
        const keys = [...new Set(attributes.map((attribute) => attribute.key))];
        const criteria = attributes.map((attribute) =>
            attribute.value === undefined
                ? {
                      type: attribute.key,
                      min: attribute.min,
                      max: attribute.max,
                  }
                : { type: attribute.key, value: attribute.value },
        );
        const rows = db.raw
            .prepare(
                "SELECT ta.token_id, ak.key, a.value FROM token_attributes ta " +
                    "JOIN attributes a ON a.id=ta.attribute_id AND a.chain_id=ta.chain_id AND a.collection_id=ta.collection_id " +
                    "JOIN attribute_keys ak ON ak.id=a.attribute_key_id AND ak.chain_id=a.chain_id AND ak.collection_id=a.collection_id " +
                    "WHERE ta.chain_id=? AND ta.collection_id=? AND ta.source_kind=? AND ta.source_key=? " +
                    `AND ak.key IN (${keys.map(() => "?").join(",")}) ORDER BY ta.token_id`,
            )
            .iterate(
                chainId,
                collectionId,
                TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
                TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
                ...keys,
            ) as Iterable<{ token_id: string; key: string; value: string }>;
        const tokenIds: string[] = [];
        let current: string | null = null;
        let traits: { type: string; value: string }[] = [];
        const finishToken = () => {
            if (current !== null && biddingTraitsMatchToken(criteria, traits))
                tokenIds.push(current);
        };
        for (const row of rows) {
            if (row.token_id !== current) {
                finishToken();
                current = row.token_id;
                traits = [];
            }
            traits.push({ type: row.key, value: row.value });
        }
        finishToken();
        return tokenIds;
    }

    private resolveSingleAttributeId(
        chainId: number,
        collectionId: number,
        contractAddress: string,
        schema: TokenSetAttributeSchema,
    ): number | null {
        const attribute = schema.data.attributes[0];
        if (!attribute || attribute.value === undefined) return null;
        const keyRow = this.selectAttributeKeyId.get({
            chainId,
            collectionId,
            key: attribute.key,
        }) as AttributeIdRow | undefined;
        if (!keyRow) return null;
        const attributeRow = this.selectAttributeId.get({
            chainId,
            collectionId,
            attributeKeyId: keyRow.id,
            value: attribute.value,
        }) as AttributeIdRow | undefined;
        return attributeRow?.id ?? null;
    }
}
