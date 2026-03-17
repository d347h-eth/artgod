import { db } from "@artgod/shared/database";
import type {
    CollectionExtensionInstall,
    CollectionExtensionKey,
} from "@artgod/shared/extensions";
import type { BackendCollectionExtensionArtifactRecord } from "../../application/collection-extensions/types.js";

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
    extension_key: CollectionExtensionKey;
    artifact_ref: string;
    image: string | null;
    animation_url: string | null;
    html_content: string | null;
};

export class SqliteCollectionExtensionRecords {
    private selectInstallByCollectionId = db.prepare<{
        chainId: number;
        collectionId: number;
    }>(
        "SELECT cei.chain_id, cei.collection_id, cei.extension_key, cei.enabled, cei.config_json, cei.created_at, cei.updated_at " +
            "FROM collection_extension_installs cei " +
            "WHERE cei.chain_id = @chainId AND cei.collection_id = @collectionId " +
            "LIMIT 1",
    );

    private selectArtifact = db.prepare<{
        chainId: number;
        collectionId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        artifactRef: string;
    }>(
        "SELECT extension_key, artifact_ref, image, animation_url, html_content " +
            "FROM token_extension_artifacts " +
            "WHERE chain_id = @chainId AND collection_id = @collectionId AND token_id = @tokenId " +
            "AND extension_key = @extensionKey AND artifact_ref = @artifactRef " +
            "LIMIT 1",
    );

    getInstallByCollectionId(
        chainId: number,
        collectionId: number,
    ): CollectionExtensionInstall | null {
        const row = this.selectInstallByCollectionId.get({
            chainId,
            collectionId,
        }) as InstallRow | undefined;
        if (!row) {
            return null;
        }

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

    getArtifact(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
        extensionKey: CollectionExtensionKey;
        artifactRef: string;
    }): BackendCollectionExtensionArtifactRecord | null {
        const row = this.selectArtifact.get({
            chainId: params.chainId,
            collectionId: params.collectionId,
            tokenId: params.tokenId,
            extensionKey: params.extensionKey,
            artifactRef: params.artifactRef,
        }) as ArtifactRow | undefined;
        if (!row) {
            return null;
        }

        return {
            extensionKey: row.extension_key,
            artifactRef: row.artifact_ref,
            image: row.image,
            animationUrl: row.animation_url,
            htmlContent: row.html_content,
        };
    }
}
