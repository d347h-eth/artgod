import { logger } from "@artgod/shared/utils";
import {
    METADATA_PENDING_LOG,
    type MetadataReadinessPort,
    type MetadataContentRetryPolicy,
    type MetadataTarget,
} from "../../domain/metadata-pending.js";
import type { TokenMetadata } from "../../domain/metadata.js";
import type { CollectionExtensionInstallPort } from "../../ports/collection-extensions.js";
import { resolveIndexerCollectionExtension } from "./index.js";

/** Collections opt into content readiness; ordinary successful metadata remains ready by default. */
export class CollectionExtensionMetadataReadiness implements MetadataReadinessPort {
    constructor(
        private readonly installs: Pick<
            CollectionExtensionInstallPort,
            "getInstall"
        >,
    ) {}
    contentRetryPolicy(
        target: MetadataTarget,
    ): MetadataContentRetryPolicy | null {
        const install = this.installs.getInstall(
            target.chainId,
            target.collectionId,
        );
        return install?.enabled
            ? (resolveIndexerCollectionExtension(install)
                  ?.metadataContentRetryPolicy ?? null)
            : null;
    }
    isReady(target: MetadataTarget, metadata: TokenMetadata): boolean {
        const install = this.installs.getInstall(
            target.chainId,
            target.collectionId,
        );
        if (!install?.enabled) return true;
        const ready =
            resolveIndexerCollectionExtension(install)?.isMetadataReady?.(
                target,
                metadata,
            ) ?? true;
        if (!ready) {
            // Report every rejected lookup, even when an existing canonical row is retained.
            logger.info(METADATA_PENDING_LOG.NotReady, {
                component: METADATA_PENDING_LOG.Component,
                chainId: target.chainId,
                collectionId: target.collectionId,
                contract: target.contract,
                tokenId: target.tokenId,
                extensionKey: install.extensionKey,
                metadataUrl: metadata.uri,
            });
        }
        return ready;
    }
}
