import { db } from "@artgod/shared/database";
import {
    getDefaultDebugPayloadPersistenceConfig,
    type DebugPayloadPersistenceConfig,
} from "@artgod/shared/config/debug-payload-persistence";
import type {
    CollectionExtensionInstall,
    CollectionExtensionKey,
} from "@artgod/shared/extensions";
import type {
    CollectionExtensionAttributePort,
    CollectionExtensionArtifactPort,
    CollectionExtensionArtifactRecord,
    CollectionExtensionArtifactUpsertInput,
    CollectionExtensionInstallPort,
    CollectionExtensionSyntheticTokenInput,
    CollectionExtensionSyntheticTokenPort,
    CollectionExtensionSyntheticTokenRetirementResult,
    CollectionExtensionTokenAttributesReplaceInput,
} from "../../ports/collection-extensions.js";
import { TOKEN_ATTRIBUTE_SOURCE_KIND } from "@artgod/shared/types/token-attributes";
import { SqliteTokenAttributeWriter } from "../attributes/sqlite-token-attributes.js";

type InstallRow = {
    chain_id: number;
    collection_id: number;
    extension_key: CollectionExtensionKey;
    enabled: number;
    config_json: string;
    created_at: string;
    updated_at: string;
};

type ArtifactRow = {
    chain_id: number;
    collection_id: number;
    contract_address: string;
    token_id: string;
    extension_key: CollectionExtensionKey;
    artifact_ref: string;
    image: string | null;
    animation_url: string | null;
    html_content: string | null;
    created_at: string;
    updated_at: string;
};

type AttributeValueRow = {
    value: string;
};

export class SqliteCollectionExtensions
    implements
        CollectionExtensionInstallPort,
        CollectionExtensionArtifactPort,
        CollectionExtensionAttributePort,
        CollectionExtensionSyntheticTokenPort
{
    private tokenAttributes = new SqliteTokenAttributeWriter();

    constructor(
        private debugPayloads: DebugPayloadPersistenceConfig = getDefaultDebugPayloadPersistenceConfig(),
    ) {}

    private selectInstall = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT chain_id, collection_id, extension_key, enabled, config_json, created_at, updated_at " +
            "FROM collection_extension_installs " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "LIMIT 1",
    );

    private selectEnabledInstalls = db.prepare<{ chainId: number }>(
        "SELECT chain_id, collection_id, extension_key, enabled, config_json, created_at, updated_at " +
            "FROM collection_extension_installs " +
            "WHERE chain_id = @chainId AND enabled = 1",
    );

    private upsertInstallStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        extensionKey: CollectionExtensionKey;
        enabled: number;
        configJson: string;
    }>(
        "INSERT INTO collection_extension_installs " +
            "(chain_id, collection_id, extension_key, enabled, config_json) " +
            "VALUES (@chainId, @collectionId, @extensionKey, @enabled, @configJson) " +
            "ON CONFLICT(chain_id, collection_id) DO UPDATE SET " +
            "extension_key = excluded.extension_key, " +
            "enabled = excluded.enabled, " +
            "config_json = excluded.config_json, " +
            "updated_at = CURRENT_TIMESTAMP",
    );

    private upsertSyntheticTokenStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        tokenId: string;
    }>(
        "INSERT INTO tokens (chain_id, collection_id, contract_address, token_id) " +
            "VALUES (@chainId, @collectionId, @contractAddress, @tokenId) " +
            "ON CONFLICT(chain_id, collection_id, token_id) DO UPDATE SET " +
            "contract_address = excluded.contract_address, updated_at = CURRENT_TIMESTAMP",
    );

    private upsertArtifactStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        contractAddress: string;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        artifactRef: string;
        uri: string | null;
        rawJson: string | null;
        attributesJson: string | null;
        image: string | null;
        animationUrl: string | null;
        htmlContent: string | null;
    }>(
        "INSERT INTO token_extension_artifacts " +
            "(chain_id, collection_id, contract_address, token_id, extension_key, artifact_ref, uri, raw_json, attributes_json, image, animation_url, html_content) " +
            "VALUES (@chainId, @collectionId, @contractAddress, @tokenId, @extensionKey, @artifactRef, @uri, @rawJson, @attributesJson, @image, @animationUrl, @htmlContent) " +
            "ON CONFLICT(chain_id, collection_id, token_id, extension_key, artifact_ref) DO UPDATE SET " +
            "uri = excluded.uri, raw_json = excluded.raw_json, attributes_json = excluded.attributes_json, " +
            "image = excluded.image, animation_url = excluded.animation_url, html_content = excluded.html_content, " +
            "updated_at = CURRENT_TIMESTAMP",
    );

    private selectArtifactStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        artifactRef: string;
    }>(
        "SELECT chain_id, collection_id, contract_address, token_id, extension_key, artifact_ref, image, animation_url, html_content, created_at, updated_at " +
            "FROM token_extension_artifacts " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND token_id = @tokenId " +
            "AND extension_key = @extensionKey AND artifact_ref = @artifactRef " +
            "LIMIT 1",
    );

    private selectTokenAttributeValueStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
        key: string;
    }>(
        "SELECT a.value AS value " +
            "FROM token_attributes ta " +
            "JOIN attributes a ON a.id = ta.attribute_id " +
            "AND a.chain_id = ta.chain_id " +
            "AND a.collection_id = ta.collection_id " +
            "JOIN attribute_keys ak ON ak.id = a.attribute_key_id " +
            "AND ak.chain_id = a.chain_id " +
            "AND ak.collection_id = a.collection_id " +
            "WHERE ta.chain_id = @chainId " +
            "AND ta.collection_id = @collectionId " +
            "AND ta.token_id = @tokenId " +
            "AND ak.key = @key " +
            "LIMIT 1",
    );

    private selectSyntheticTokenCanonicalStateStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        sourceKind: string;
    }>(
        "SELECT " +
            "EXISTS(SELECT 1 FROM token_metadata tm WHERE tm.chain_id = @chainId AND tm.collection_id = @collectionId AND tm.token_id = @tokenId) AS has_metadata, " +
            "EXISTS(SELECT 1 FROM token_attributes ta WHERE ta.chain_id = @chainId AND ta.collection_id = @collectionId AND ta.token_id = @tokenId AND NOT (ta.source_kind = @sourceKind AND ta.source_key = @extensionKey)) AS has_unowned_attributes, " +
            "EXISTS(SELECT 1 FROM token_extension_artifacts tea WHERE tea.chain_id = @chainId AND tea.collection_id = @collectionId AND tea.token_id = @tokenId AND tea.extension_key <> @extensionKey) AS has_unowned_artifacts, " +
            "EXISTS(SELECT 1 FROM nft_balances nb WHERE nb.chain_id = @chainId AND nb.collection_id = @collectionId AND nb.token_id = @tokenId) AS has_ownership, " +
            "EXISTS(SELECT 1 FROM orders o WHERE o.chain_id = @chainId AND o.collection_id = @collectionId AND o.token_id = @tokenId) AS has_orders",
    );

    private deleteSyntheticTokenAttributesStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        sourceKind: string;
    }>(
        "DELETE FROM token_attributes " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND token_id = @tokenId AND source_kind = @sourceKind " +
            "AND source_key = @extensionKey",
    );

    private deleteSyntheticTokenArtifactsStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
    }>(
        "DELETE FROM token_extension_artifacts " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND token_id = @tokenId AND extension_key = @extensionKey",
    );

    private deleteSyntheticTokenStmt = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
    }>(
        "DELETE FROM tokens " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId " +
            "AND token_id = @tokenId",
    );

    getInstall(
        chainId: number,
        collectionId: number,
    ): CollectionExtensionInstall | null {
        const row = this.selectInstall.get({
            chainId,
            collectionId,
        }) as InstallRow | undefined;
        return row ? mapInstallRow(row) : null;
    }

    listEnabledInstalls(chainId: number): CollectionExtensionInstall[] {
        const rows = this.selectEnabledInstalls.all({
            chainId,
        }) as InstallRow[];
        return rows.map(mapInstallRow);
    }

    upsertInstall(input: {
        chainId: number;
        collectionId: number;
        extensionKey: CollectionExtensionKey;
        enabled: boolean;
        configJson: string;
    }): void {
        this.upsertInstallStmt.run({
            chainId: input.chainId,
            collectionId: input.collectionId,
            extensionKey: input.extensionKey,
            enabled: input.enabled ? 1 : 0,
            configJson: input.configJson,
        });
    }

    upsertArtifact(input: CollectionExtensionArtifactUpsertInput): void {
        this.upsertArtifactStmt.run({
            chainId: input.chainId,
            collectionId: input.collectionId,
            contractAddress: input.contractAddress.toLowerCase(),
            tokenId: input.tokenId,
            extensionKey: input.extensionKey,
            artifactRef: input.artifactRef,
            uri: this.debugPayloads.persistRawDebugPayloads ? input.uri : null,
            rawJson: this.debugPayloads.persistRawDebugPayloads
                ? input.rawJson
                : null,
            attributesJson: this.debugPayloads.persistRawDebugPayloads
                ? input.attributesJson
                : null,
            image: input.image,
            animationUrl: input.animationUrl,
            htmlContent: input.htmlContent,
        });
    }

    upsertSyntheticToken(input: CollectionExtensionSyntheticTokenInput): void {
        const assertAndPersist = db.raw.transaction(() => {
            const state = this.getSyntheticTokenCanonicalState(input);
            if (hasSyntheticTokenCanonicalState(state)) {
                throw new Error(
                    `Synthetic token ${input.tokenId} already has non-extension-owned state`,
                );
            }
            this.upsertSyntheticTokenStmt.run({
                chainId: input.chainId,
                collectionId: input.collectionId,
                contractAddress: input.contractAddress.toLowerCase(),
                tokenId: input.tokenId,
            });
        });
        assertAndPersist();
    }

    retireSyntheticToken(
        input: CollectionExtensionSyntheticTokenInput,
    ): CollectionExtensionSyntheticTokenRetirementResult {
        const retire = db.raw.transaction(() => {
            const state = this.getSyntheticTokenCanonicalState(input);
            if (hasSyntheticTokenCanonicalState(state)) {
                return {
                    retired: false,
                    blockedByCanonicalState: true,
                };
            }

            const params = {
                chainId: input.chainId,
                collectionId: input.collectionId,
                tokenId: input.tokenId,
                extensionKey: input.extensionKey,
                sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
            };
            this.deleteSyntheticTokenAttributesStmt.run(params);
            this.deleteSyntheticTokenArtifactsStmt.run(params);
            const result = this.deleteSyntheticTokenStmt.run({
                chainId: input.chainId,
                collectionId: input.collectionId,
                tokenId: input.tokenId,
            });
            return {
                retired: result.changes > 0,
                blockedByCanonicalState: false,
            };
        });
        return retire() as CollectionExtensionSyntheticTokenRetirementResult;
    }

    getArtifact(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        artifactRef: string;
    }): CollectionExtensionArtifactRecord | null {
        const row = this.selectArtifactStmt.get({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenId: params.tokenId,
            extensionKey: params.extensionKey,
            artifactRef: params.artifactRef,
        }) as ArtifactRow | undefined;
        return row ? mapArtifactRow(row) : null;
    }

    getTokenAttributeValue(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        key: string;
    }): string | null {
        const row = this.selectTokenAttributeValueStmt.get({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenId: params.tokenId,
            key: params.key,
        }) as AttributeValueRow | undefined;
        return row?.value ?? null;
    }

    replaceTokenAttributes(
        input: CollectionExtensionTokenAttributesReplaceInput,
    ): void {
        const persist = db.raw.transaction(() => {
            this.tokenAttributes.replaceTokenAttributes({
                chainId: input.chainId,
                collectionId: input.collectionId,
                contractAddress: input.contractAddress.toLowerCase(),
                tokenId: input.tokenId,
                sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
                sourceKey: input.extensionKey,
                attributes: input.attributes,
            });
        });
        persist();
    }

    private getSyntheticTokenCanonicalState(
        input: CollectionExtensionSyntheticTokenInput,
    ): SyntheticTokenCanonicalState {
        return this.selectSyntheticTokenCanonicalStateStmt.get({
            chainId: input.chainId,
            collectionId: input.collectionId,
            tokenId: input.tokenId,
            extensionKey: input.extensionKey,
            sourceKind: TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
        }) as SyntheticTokenCanonicalState;
    }
}

function mapInstallRow(row: InstallRow): CollectionExtensionInstall {
    return {
        chainId: row.chain_id,
        collectionId: row.collection_id,
        extensionKey: row.extension_key,
        enabled: row.enabled === 1,
        configJson: row.config_json,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function mapArtifactRow(row: ArtifactRow): CollectionExtensionArtifactRecord {
    return {
        chainId: row.chain_id,
        collectionId: row.collection_id,
        contractAddress: row.contract_address,
        tokenId: row.token_id,
        extensionKey: row.extension_key,
        artifactRef: row.artifact_ref,
        image: row.image,
        animationUrl: row.animation_url,
        htmlContent: row.html_content,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

type SyntheticTokenCanonicalState = {
    has_metadata: number;
    has_unowned_attributes: number;
    has_unowned_artifacts: number;
    has_ownership: number;
    has_orders: number;
};

function hasSyntheticTokenCanonicalState(
    row: SyntheticTokenCanonicalState,
): boolean {
    return (
        row.has_metadata === 1 ||
        row.has_unowned_attributes === 1 ||
        row.has_unowned_artifacts === 1 ||
        row.has_ownership === 1 ||
        row.has_orders === 1
    );
}
