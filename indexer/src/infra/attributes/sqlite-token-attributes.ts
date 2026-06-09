import { db } from "@artgod/shared/database";
import type { TokenAttributeSourceKind } from "@artgod/shared/types/token-attributes";
import {
    type NormalizedAttribute,
    normalizeUniqueAttributeList,
} from "../../domain/attributes.js";

export type SqliteTokenAttributeReplacementInput = {
    chainId: number;
    collectionId: number;
    contractAddress: string;
    tokenId: string;
    sourceKind: TokenAttributeSourceKind;
    sourceKey: string;
    attributes: readonly NormalizedAttribute[];
};

type AttributeKeyRow = { id: number };
type AttributeRow = { id: number };

export class SqliteTokenAttributeWriter {
    private deleteTokenAttributes = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
        sourceKind: TokenAttributeSourceKind;
        sourceKey: string;
    }>(
        "DELETE FROM token_attributes " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND token_id = @tokenId AND source_kind = @sourceKind " +
            "AND source_key = @sourceKey",
    );

    private insertAttributeKey = db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        key: string;
    }>(
        "INSERT OR IGNORE INTO attribute_keys " +
            "(chain_id, collection_id, contract_address, key) " +
            "VALUES (@chainId, @collectionId, @contractAddress, @key)",
    );

    private selectAttributeKeyId = db.prepare<{
        chainId: number;
        collectionId: number;
        key: string;
    }>(
        "SELECT id FROM attribute_keys " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND key = @key",
    );

    private insertAttribute = db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        attributeKeyId: number;
        value: string;
    }>(
        "INSERT OR IGNORE INTO attributes " +
            "(chain_id, collection_id, contract_address, attribute_key_id, value) " +
            "VALUES (@chainId, @collectionId, @contractAddress, @attributeKeyId, @value)",
    );

    private selectAttributeId = db.prepare<{
        chainId: number;
        collectionId: number;
        attributeKeyId: number;
        value: string;
    }>(
        "SELECT id FROM attributes " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND attribute_key_id = @attributeKeyId AND value = @value",
    );

    private insertTokenAttribute = db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        tokenId: string;
        attributeId: number;
        sourceKind: TokenAttributeSourceKind;
        sourceKey: string;
    }>(
        "INSERT OR IGNORE INTO token_attributes " +
            "(chain_id, collection_id, contract_address, token_id, attribute_id, source_kind, source_key) " +
            "VALUES (@chainId, @collectionId, @contractAddress, @tokenId, @attributeId, @sourceKind, @sourceKey)",
    );

    // Replaces only the links owned by the supplied source; shared key/value rows remain reusable.
    replaceTokenAttributes(input: SqliteTokenAttributeReplacementInput): void {
        const attributes = normalizeUniqueAttributeList([...input.attributes]);
        this.deleteTokenAttributes.run({
            chainId: input.chainId,
            collectionId: input.collectionId,
            tokenId: input.tokenId,
            sourceKind: input.sourceKind,
            sourceKey: input.sourceKey,
        });

        for (const attribute of attributes) {
            this.insertAttributeKey.run({
                chainId: input.chainId,
                collectionId: input.collectionId,
                contractAddress: input.contractAddress,
                key: attribute.key,
            });
            const keyRow = this.selectAttributeKeyId.get({
                chainId: input.chainId,
                collectionId: input.collectionId,
                key: attribute.key,
            }) as AttributeKeyRow | undefined;
            if (!keyRow) continue;

            this.insertAttribute.run({
                chainId: input.chainId,
                collectionId: input.collectionId,
                contractAddress: input.contractAddress,
                attributeKeyId: keyRow.id,
                value: attribute.value,
            });
            const attributeRow = this.selectAttributeId.get({
                chainId: input.chainId,
                collectionId: input.collectionId,
                attributeKeyId: keyRow.id,
                value: attribute.value,
            }) as AttributeRow | undefined;
            if (!attributeRow) continue;

            this.insertTokenAttribute.run({
                chainId: input.chainId,
                collectionId: input.collectionId,
                contractAddress: input.contractAddress,
                tokenId: input.tokenId,
                attributeId: attributeRow.id,
                sourceKind: input.sourceKind,
                sourceKey: input.sourceKey,
            });
        }
    }
}
