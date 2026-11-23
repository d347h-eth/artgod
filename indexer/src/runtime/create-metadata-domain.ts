import { SqliteTraitCatalog } from "../infra/metadata/sqlite-trait-catalog.js";
import { installedCatalogMapper } from "../application/collection-extensions/trait-catalog.js";
import {
    getDefaultDebugPayloadPersistenceConfig,
    type DebugPayloadPersistenceConfig,
} from "@artgod/shared/config/debug-payload-persistence";
import { MetadataDomain } from "../application/metadata/domain.js";
import { CollectionExtensionMetadataReadiness } from "../application/collection-extensions/metadata-readiness.js";
import { SqliteCollectionExtensions } from "../infra/collection-extensions/sqlite.js";
import { SqliteMetadataStore } from "../infra/metadata/sqlite-metadata-store.js";
import type {
    MetadataFetcherPort,
    TokenUriResolverPort,
} from "../ports/metadata.js";

/** Shared composition for bootstrap and domain runtimes; every entry path retains the same obligation. */
export function createMetadataDomain(
    resolver: TokenUriResolverPort,
    fetcher: MetadataFetcherPort,
    debugPayloads: DebugPayloadPersistenceConfig = getDefaultDebugPayloadPersistenceConfig(),
): MetadataDomain {
    const installs = new SqliteCollectionExtensions(debugPayloads);
    return new MetadataDomain({
        resolver,
        fetcher,
        store: new SqliteMetadataStore(
            debugPayloads,
            new SqliteTraitCatalog(installedCatalogMapper(installs)),
        ),
        readiness: new CollectionExtensionMetadataReadiness(installs),
    });
}
