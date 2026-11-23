import {
    type CatalogRequest,
    type CatalogScopeReadPort,
    resolveTraitScope,
} from "./collection-views.js";
import type {
    ChainRecord,
    CollectionListItem,
} from "@artgod/shared/types/browse";

export type GetTokenUriInput = CatalogRequest & {
    chainRef: string;
    collectionRef: string;
    tokenRef: string;
};

export type GetTokenUriOutput = {
    uri: string;
};

type TokenUriReadPort = {
    getTokenUri(params: {
        chainId: number;
        collectionId: number;
        contract: string;
        tokenId: string;
    }): Promise<string>;
};

export class GetTokenUriUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly collectionReadPort: CatalogScopeReadPort & {
            resolveCollectionRef(
                chainId: number,
                collectionRef: string,
            ): CollectionListItem;
        },
        readonly tokenUriReadPort: TokenUriReadPort,
    ) {}

    async getTokenUri(input: GetTokenUriInput): Promise<GetTokenUriOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const collection = this.collectionReadPort.resolveCollectionRef(
            chain.publicChainId,
            input.collectionRef,
        );
        resolveTraitScope(
            this.collectionReadPort,
            collection,
            input,
            input.tokenRef,
        );
        const uri = await this.tokenUriReadPort.getTokenUri({
            chainId: chain.publicChainId,
            collectionId: collection.collectionId,
            contract: collection.address,
            tokenId: input.tokenRef,
        });
        return { uri };
    }
}
