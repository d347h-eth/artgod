import { db } from "@artgod/shared/database";
import { logger } from "@artgod/shared/utils";
import { toHex } from "viem";
import type {
    TokenSetRegistryPort,
    TokenSetRequest,
} from "../../ports/token-sets.js";
import type {
    TokenSetSchema,
    TokenSetResolution,
} from "../../domain/token-sets.js";
import {
    buildTokenSetId,
    generateMerkleRoot,
    generateSchemaHash,
    normalizeSchema,
} from "../../application/token-sets/utils.js";

type AttributeIdRow = { id: number };
type TokenIdRow = { token_id: string };

export class SqliteTokenSetRegistry implements TokenSetRegistryPort {
    private insertTokenSet = db.prepare<{
        chainId: number;
        tokenSetId: string;
        schemaHash: string;
        schemaJson: string;
        contractAddress: string;
        attributeId: number | null;
        merkleRoot: string | null;
    }>(
        "INSERT INTO token_sets " +
            "(chain_id, id, schema_hash, schema_json, contract_address, attribute_id, merkle_root) " +
            "VALUES (@chainId, @tokenSetId, @schemaHash, @schemaJson, @contractAddress, @attributeId, @merkleRoot) " +
            "ON CONFLICT(chain_id, id, schema_hash) DO UPDATE SET " +
            "schema_json = excluded.schema_json, " +
            "contract_address = excluded.contract_address, " +
            "attribute_id = excluded.attribute_id, " +
            "merkle_root = excluded.merkle_root, " +
            "updated_at = CURRENT_TIMESTAMP",
    );
    private insertTokenSetToken = db.prepare<{
        chainId: number;
        tokenSetId: string;
        contractAddress: string;
        tokenId: string;
    }>(
        "INSERT OR IGNORE INTO token_sets_tokens " +
            "(chain_id, token_set_id, contract_address, token_id) " +
            "VALUES (@chainId, @tokenSetId, @contractAddress, @tokenId)",
    );
    private selectAttributeKeyId = db.prepare<{
        chainId: number;
        contractAddress: string;
        key: string;
    }>(
        "SELECT id FROM attribute_keys WHERE chain_id = @chainId AND contract_address = @contractAddress AND key = @key",
    );
    private selectAttributeId = db.prepare<{
        chainId: number;
        contractAddress: string;
        attributeKeyId: number;
        value: string;
    }>(
        "SELECT id FROM attributes WHERE chain_id = @chainId AND contract_address = @contractAddress AND attribute_key_id = @attributeKeyId AND value = @value",
    );
    private selectCollectionTokenIds = db.prepare<{
        chainId: number;
        contractAddress: string;
    }>(
        "SELECT DISTINCT token_id FROM nft_balances " +
            "WHERE chain_id = @chainId AND contract_address = @contractAddress " +
            "ORDER BY token_id",
    );

    ensureTokenSet(request: TokenSetRequest): TokenSetResolution | null {
        const schema = normalizeSchema(request.schema);
        const schemaHash = generateSchemaHash(schema);
        const contractAddress = schema.data.collection.toLowerCase();
        const tokenIds =
            schema.kind === "attribute"
                ? this.resolveTokensByAttributes(
                      request.chainId,
                      contractAddress,
                      schema,
                  )
                : this.resolveTokensByCollection(
                      request.chainId,
                      contractAddress,
                  );
        const criteriaRoot = request.criteriaRoot
            ? safeNormalizeCriteriaRoot(
                  request.criteriaRoot,
                  request.chainId,
                  contractAddress,
              )
            : null;

        let merkleRoot: string | null = null;
        if (tokenIds.length > 0) {
            merkleRoot = generateMerkleRoot(tokenIds);
        } else if (criteriaRoot) {
            merkleRoot = criteriaRoot;
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

        if (tokenIds.length > 0 && criteriaRoot) {
            const expected = criteriaRoot;
            if (expected.toLowerCase() !== merkleRoot.toLowerCase()) {
                logger.warn("Token set criteria root mismatch", {
                    component: "TokenSetRegistry",
                    action: "ensureTokenSet",
                    chainId: request.chainId,
                    contractAddress,
                    kind: schema.kind,
                    expected,
                    resolved: merkleRoot,
                });
                return null;
            }
        }

        const tokenSetId = buildTokenSetId(contractAddress, merkleRoot);
        const attributeId =
            schema.kind === "attribute" && schema.data.attributes.length === 1
                ? this.resolveSingleAttributeId(
                      request.chainId,
                      contractAddress,
                      schema,
                  )
                : null;

        this.insertTokenSet.run({
            chainId: request.chainId,
            tokenSetId,
            schemaHash,
            schemaJson: JSON.stringify(schema),
            contractAddress,
            attributeId,
            merkleRoot,
        });

        if (tokenIds.length > 0) {
            const insertTokens = db.raw.transaction(() => {
                for (const tokenId of tokenIds) {
                    this.insertTokenSetToken.run({
                        chainId: request.chainId,
                        tokenSetId,
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
        contractAddress: string,
    ): string[] {
        const rows = this.selectCollectionTokenIds.all({
            chainId,
            contractAddress,
        }) as TokenIdRow[];
        return rows.map((row) => row.token_id);
    }

    private resolveTokensByAttributes(
        chainId: number,
        contractAddress: string,
        schema: TokenSetSchema & { kind: "attribute" },
    ): string[] {
        const attributes = schema.data.attributes;
        if (!attributes.length) return [];

        // AND semantics: all attribute pairs must be present for the same token_id.
        const values: Record<string, string | number> = {
            chainId,
            contractAddress,
            attributesCount: attributes.length,
        };
        const clauses = attributes.map((attribute, index) => {
            const key = `key${index}`;
            const value = `value${index}`;
            values[key] = attribute.key;
            values[value] = attribute.value;
            return `(attribute_keys.key = @${key} AND attributes.value = @${value})`;
        });

        const sql =
            "SELECT token_attributes.token_id " +
            "FROM token_attributes " +
            "JOIN attributes ON token_attributes.attribute_id = attributes.id " +
            "JOIN attribute_keys ON attributes.attribute_key_id = attribute_keys.id " +
            "WHERE token_attributes.chain_id = @chainId " +
            "AND token_attributes.contract_address = @contractAddress " +
            "AND attributes.chain_id = @chainId " +
            "AND attributes.contract_address = @contractAddress " +
            "AND attribute_keys.chain_id = @chainId " +
            "AND attribute_keys.contract_address = @contractAddress " +
            `AND (${clauses.join(" OR ")}) ` +
            "GROUP BY token_attributes.token_id " +
            "HAVING COUNT(DISTINCT (attribute_keys.key || ':' || attributes.value)) = @attributesCount " +
            "ORDER BY token_attributes.token_id";

        const rows = db.prepare(sql).all(values) as TokenIdRow[];
        return rows.map((row) => row.token_id);
    }

    private resolveSingleAttributeId(
        chainId: number,
        contractAddress: string,
        schema: TokenSetSchema & { kind: "attribute" },
    ): number | null {
        const attribute = schema.data.attributes[0];
        if (!attribute) return null;
        const keyRow = this.selectAttributeKeyId.get({
            chainId,
            contractAddress,
            key: attribute.key,
        }) as AttributeIdRow | undefined;
        if (!keyRow) return null;
        const attributeRow = this.selectAttributeId.get({
            chainId,
            contractAddress,
            attributeKeyId: keyRow.id,
            value: attribute.value,
        }) as AttributeIdRow | undefined;
        return attributeRow?.id ?? null;
    }
}

function safeNormalizeCriteriaRoot(
    value: string,
    chainId: number,
    contractAddress: string,
): string | null {
    if (value.startsWith("0x")) return value.toLowerCase();
    if (!/^\d+$/.test(value)) {
        logger.warn("Token set criteria root not parseable", {
            component: "TokenSetRegistry",
            action: "normalizeCriteriaRoot",
            chainId,
            contractAddress,
            value,
        });
        return null;
    }
    return toHex(BigInt(value), { size: 32 });
}
