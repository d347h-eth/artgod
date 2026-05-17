import type {
    ChainRecord,
    CollectionListItem,
} from "@artgod/shared/types/browse";

// Input accepted by the collection purge core use case.
export type PurgeCollectionInput = {
    chainRef: string;
    collectionRef: string;
    confirmation: string;
};

// Per-table delete counts returned by the purge persistence adapter.
export type PurgeCollectionDeletedRowCount = {
    table: string;
    rowCount: number;
};

// Transport-agnostic collection purge result returned to inbound adapters.
export type PurgeCollectionOutput = {
    chain: ChainRecord;
    collection: CollectionListItem;
    deletedRows: PurgeCollectionDeletedRowCount[];
    totalDeletedRows: number;
};

type PurgeCollectionDataInput = {
    chainId: number;
    collectionId: number;
};

// Validation error mapped by HTTP adapters to a user-correctable response.
export class PurgeCollectionValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PurgeCollectionValidationError";
    }
}

// PurgeCollectionUseCase removes all collection-scoped database state after explicit confirmation.
export class PurgeCollectionUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionReadPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
        },
        readonly collectionPurgePort: {
            purgeCollectionData(
                input: PurgeCollectionDataInput,
            ): PurgeCollectionDeletedRowCount[];
        },
    ) {}

    purgeCollection(input: PurgeCollectionInput): PurgeCollectionOutput {
        assertPurgeConfirmation(input.confirmation);

        // Resolve the chain before loading collection-scoped database state.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Resolve the collection once so the purge deletes by stable internal id.
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );

        // Delete collection-scoped rows inside the outbound persistence adapter.
        const deletedRows = this.collectionPurgePort.purgeCollectionData({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
        });

        return {
            chain,
            collection,
            deletedRows,
            totalDeletedRows: deletedRows.reduce(
                (sum, row) => sum + row.rowCount,
                0,
            ),
        };
    }
}

function assertPurgeConfirmation(confirmation: string): void {
    if (confirmation.trim().toLowerCase() !== "purge") {
        throw new PurgeCollectionValidationError(
            'Collection purge requires confirmation word "purge"',
        );
    }
}
