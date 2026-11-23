import type {
    ChainRecord,
    CollectionListItem,
    TraitFilter,
} from "@artgod/shared/types/browse";
import {
    TRAIT_CATALOG_REBUILD_STATUS,
    TRAIT_CATALOG,
    type CollectionViewStatus,
    type CollectionViewsResponse,
    type TraitCatalogRebuild,
    type TraitReadContext,
    type TraitCatalogMapper,
} from "@artgod/shared/types/trait-catalog";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import {
    decodeOpaqueCursor,
    encodeOpaqueCursor,
} from "@artgod/shared/utils/cursor";
import { resolveCollectionTraitMapper } from "../../collection-extensions/index.js";

export type CatalogRequest = {
    view?: string;
    traitCatalog?: TraitReadContext["catalog"];
    generation?: number;
};

export type CatalogScopeReadPort = {
    readViewStatus?(
        chainId: number,
        collectionId: number,
        mapper: TraitCatalogMapper,
        viewId?: string,
    ): CollectionViewStatus[];
    readTokenViewId?(
        chainId: number,
        collectionId: number,
        tokenId: string,
    ): string | null;
};

function selection(
    port: CatalogScopeReadPort,
    collection: CollectionListItem,
    request: CatalogRequest,
    tokenId?: string,
    allViews = false,
) {
    const mapper = resolveCollectionTraitMapper(collection.extensions ?? []);
    if (!mapper) {
        if (
            request.view ||
            request.traitCatalog === TRAIT_CATALOG.Derived ||
            request.generation !== undefined
        )
            throw new ReadModelBadRequestError(
                "Collection has no derived trait views",
            );
        return { required: false, views: [], selectedViewId: null };
    }
    if (!port.readViewStatus || !port.readTokenViewId)
        throw new Error("Collection view reads are unavailable");
    const membership =
        tokenId === undefined
            ? null
            : port.readTokenViewId(
                  collection.chainId,
                  collection.collectionId,
                  tokenId,
              );
    if (tokenId !== undefined && !membership)
        throw new ReadModelNotFoundError("Token has no classified view");
    if (request.view && membership && request.view !== membership)
        throw new ReadModelBadRequestError("Token belongs to a different view");
    const selectedViewId = request.view ?? membership;
    if (!allViews && !selectedViewId)
        throw new ReadModelBadRequestError("Choose a collection view");
    const views = port.readViewStatus(
        collection.chainId,
        collection.collectionId,
        mapper,
        allViews ? undefined : (selectedViewId ?? undefined),
    );
    const selected = views.find((view) => view.id === selectedViewId);
    if (selectedViewId && !selected)
        throw new ReadModelBadRequestError("Unknown collection view");
    if (
        request.generation !== undefined &&
        request.generation !== selected?.generation
    )
        throw new ReadModelBadRequestError(
            "Trait catalog changed. Reload this view.",
        );
    return { required: true, views, selectedViewId };
}

/** Resolve once per application request. The scope is carried to every presentation read. */
export function resolveTraitScope(
    port: CatalogScopeReadPort,
    collection: CollectionListItem,
    request: CatalogRequest,
    tokenId?: string,
) {
    const discovery = selection(port, collection, request, tokenId);
    if (!discovery.required)
        return {
            traitContext: request.traitCatalog
                ? ({
                      viewId: null,
                      catalog: request.traitCatalog,
                      generation: null,
                  } satisfies TraitReadContext)
                : undefined,
            view: undefined,
        };
    const view = discovery.views.find(
        (item) => item.id === discovery.selectedViewId,
    );
    if (!view) throw new ReadModelBadRequestError("Choose a collection view");
    return {
        traitContext: {
            viewId: view.id,
            catalog: request.traitCatalog ?? TRAIT_CATALOG.Derived,
            generation: view.generation,
        } satisfies TraitReadContext,
        view,
    };
}

/** Membership enforces the pin even while this token's projection is pending. */
export function ordinaryViewTraits(
    pinned: readonly TraitFilter[],
    selected: TraitFilter[],
): TraitFilter[] {
    if (!pinned.length) return selected;
    return selected.filter((trait) => {
        const scope = pinned.find((pin) => pin.key === trait.key);
        if (scope && scope.value !== trait.value)
            throw new ReadModelBadRequestError(
                "Trait selection conflicts with the selected view",
            );
        return !scope;
    });
}

export function unwrapCatalogCursor(
    cursor: string | null | undefined,
    context?: TraitReadContext,
): string | undefined {
    if (!context || !cursor) return cursor ?? undefined;
    try {
        const envelope = decodeOpaqueCursor<{
            scope: TraitReadContext;
            cursor: string;
        }>(cursor);
        if (
            envelope.scope.viewId === context.viewId &&
            envelope.scope.catalog === context.catalog &&
            envelope.scope.generation === context.generation &&
            typeof envelope.cursor === "string"
        )
            return envelope.cursor;
    } catch {
        /* Reject malformed and legacy cursors for scoped reads. */
    }
    throw new ReadModelBadRequestError(
        "Cursor belongs to another catalog or view",
    );
}

export function wrapCatalogPage<
    T extends { nextCursor: string | null; prevCursor?: string | null },
>(page: T, scope?: TraitReadContext): T {
    if (!scope) return page;
    const wrap = (cursor: string | null) =>
        cursor ? encodeOpaqueCursor({ scope, cursor }) : null;
    return {
        ...page,
        nextCursor: wrap(page.nextCursor),
        ...(page.prevCursor !== undefined
            ? { prevCursor: wrap(page.prevCursor) }
            : {}),
    };
}

type ViewRequest = CatalogRequest & {
    chainRef: string;
    collectionRef: string;
    tokenId?: string;
};
type ViewCommands = {
    requestTraitCatalogRebuild(input: {
        chainId: number;
        collectionId: number;
        viewId: string;
        mapperVersion: string;
        retryRunId?: number;
    }): TraitCatalogRebuild;
    getTraitCatalogRebuild(
        chainId: number,
        collectionId: number,
        runId: number,
    ): TraitCatalogRebuild | null;
};

export class CollectionViewsUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chains: {
            resolveChainRef(ref: string, chainId: number): ChainRecord;
        },
        private readonly collections: CatalogScopeReadPort & {
            resolveCollectionRef(
                chainId: number,
                ref: string,
            ): CollectionListItem;
        },
        private readonly commands: ViewCommands,
    ) {}
    private collection(input: ViewRequest) {
        const chain = this.chains.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        return this.collections.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
    }
    discover(
        input: ViewRequest,
    ): CollectionViewsResponse & { collection: CollectionListItem } {
        const collection = this.collection(input);
        return {
            collection,
            ...selection(
                this.collections,
                collection,
                input,
                input.tokenId,
                true,
            ),
        };
    }
    rebuild(
        input: ViewRequest & { mapperVersion?: string; retryRunId?: number },
    ) {
        const collection = this.collection(input);
        const { view } = resolveTraitScope(this.collections, collection, input);
        if (
            !view ||
            (input.mapperVersion !== undefined &&
                input.mapperVersion !== view.availableMapperVersion)
        )
            throw new ReadModelBadRequestError(
                "Choose an available mapper version",
            );
        if (input.retryRunId !== undefined) {
            const previous = this.commands.getTraitCatalogRebuild(
                collection.chainId,
                collection.collectionId,
                input.retryRunId,
            );
            if (
                !previous ||
                previous.viewId !== view.id ||
                previous.runId !== view.latestRun?.runId ||
                previous.status === TRAIT_CATALOG_REBUILD_STATUS.Completed ||
                previous.mapperVersion !== view.availableMapperVersion
            )
                throw new ReadModelBadRequestError(
                    "Choose a failed rebuild for this view and version",
                );
        }
        return {
            rebuild: this.commands.requestTraitCatalogRebuild({
                chainId: collection.chainId,
                collectionId: collection.collectionId,
                viewId: view.id,
                mapperVersion: view.availableMapperVersion,
                retryRunId: input.retryRunId,
            }),
        };
    }
    progress(input: ViewRequest & { runId: number }) {
        const collection = this.collection(input);
        const rebuild = this.commands.getTraitCatalogRebuild(
            collection.chainId,
            collection.collectionId,
            input.runId,
        );
        if (
            !rebuild ||
            !resolveCollectionTraitMapper(collection.extensions ?? [])
        )
            throw new ReadModelNotFoundError("Unknown catalog rebuild");
        return { rebuild };
    }
}
