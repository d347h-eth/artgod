import { ReadModelNotFoundError } from "@artgod/shared/read-models/errors";
import type {
    ChainRecord,
    CollectionStatus,
    OpenSeaStreamIngestionStatus,
} from "@artgod/shared/types";

export type UpdateOpenSeaStreamIngestionInput = {
    chainRef: string;
    collectionRef: string;
    status: OpenSeaStreamIngestionStatus;
};

export type OpenSeaStreamIngestionState = {
    chainId: number;
    collectionId: number;
    slug: string;
    status: CollectionStatus;
    openseaSlug: string | null;
    openseaStreamIngestionStatus: OpenSeaStreamIngestionStatus;
};

export type UpdateOpenSeaStreamIngestionOutput = {
    chain: ChainRecord;
    collection: OpenSeaStreamIngestionState;
    openseaStreamIngestionStatus: OpenSeaStreamIngestionStatus;
};

export class UpdateOpenSeaStreamIngestionUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        private readonly streamIngestionPort: {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): OpenSeaStreamIngestionState | null;
            setOpenSeaStreamIngestionStatus(input: {
                chainId: number;
                collectionId: number;
                status: OpenSeaStreamIngestionStatus;
            }): OpenSeaStreamIngestionState | null;
        },
    ) {}

    update(
        input: UpdateOpenSeaStreamIngestionInput,
    ): UpdateOpenSeaStreamIngestionOutput {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.streamIngestionPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        if (!collection) {
            throw new ReadModelNotFoundError("Unknown collection_ref");
        }

        // Persist the operator gate before the stream worker reads subscriptions.
        const updated =
            this.streamIngestionPort.setOpenSeaStreamIngestionStatus({
                chainId: collection.chainId,
                collectionId: collection.collectionId,
                status: input.status,
            });
        if (!updated) {
            throw new ReadModelNotFoundError("Unknown collection_ref");
        }

        return {
            chain,
            collection: updated,
            openseaStreamIngestionStatus:
                updated.openseaStreamIngestionStatus,
        };
    }
}
