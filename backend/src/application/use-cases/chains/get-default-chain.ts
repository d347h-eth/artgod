import type { ChainRecord } from "@artgod/shared/types/browse";

export type GetDefaultChainOutput = {
    chain: ChainRecord;
};

export class GetDefaultChainUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly defaultChainReadPort: {
            getDefaultChain(defaultPublicChainId: number): ChainRecord;
        },
    ) {}

    getDefaultChain(): GetDefaultChainOutput {
        return {
            chain: this.defaultChainReadPort.getDefaultChain(
                this.defaultChainId,
            ),
        };
    }
}
