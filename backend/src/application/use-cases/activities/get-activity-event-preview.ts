import type {
    ChainRecord,
    CollectionListItem,
    CollectionMediaState,
    TokenMediaPreview,
} from "@artgod/shared/types/browse";

export type GetActivityEventPreviewInput = {
    chainRef: string;
    collectionRef: string;
    activityId: number;
    renderMode?: string;
};

export type GetActivityEventPreviewOutput = {
    media: CollectionMediaState;
    token: TokenMediaPreview;
};

type ActivityEventPreviewPort = {
    getActivityEventPreview(params: {
        chainId: number;
        collectionId: number;
        activityId: number;
        renderMode?: string;
    }): Promise<GetActivityEventPreviewOutput>;
};

export class GetActivityEventPreviewUseCase {
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
        readonly activityEventPreviewPort: ActivityEventPreviewPort,
    ) {}

    async getActivityEventPreview(
        input: GetActivityEventPreviewInput,
    ): Promise<GetActivityEventPreviewOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        return this.activityEventPreviewPort.getActivityEventPreview({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            activityId: input.activityId,
            renderMode: input.renderMode,
        });
    }
}
