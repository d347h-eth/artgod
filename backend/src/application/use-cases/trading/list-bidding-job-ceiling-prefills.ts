import { formatEther } from "viem";
import type { ChainRecord } from "@artgod/shared/types";

// Exact persisted maximum returned by the bidding ceiling prefill read port.
export type BiddingJobCeilingPrefillMaximum = {
    collectionId: number;
    maxCeilingWei: string;
};

export type ListBiddingJobCeilingPrefillsInput = {
    chainRef: string;
};

export type ListBiddingJobCeilingPrefillsOutput = {
    chain: ChainRecord;
    prefills: Array<{
        collectionId: number;
        maxCeilingEth: string;
    }>;
};

// Resolves chain-wide job ceiling prefills into Admin-facing Ether units.
export class ListBiddingJobCeilingPrefillsUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly biddingJobCeilingPrefillsReadPort: {
            listCeilingPrefillMaxima(params: {
                chainId: number;
            }): BiddingJobCeilingPrefillMaximum[];
        },
    ) {}

    listBiddingJobCeilingPrefills(
        input: ListBiddingJobCeilingPrefillsInput,
    ): ListBiddingJobCeilingPrefillsOutput {
        // Resolve the requested chain before reading its enabled and paused bidding jobs.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Format exact persisted maxima for the Admin WETH input contract.
        const prefills =
            this.biddingJobCeilingPrefillsReadPort.listCeilingPrefillMaxima({
                chainId: chain.publicChainId,
            });

        return {
            chain,
            prefills: prefills.map((prefill) => ({
                collectionId: prefill.collectionId,
                maxCeilingEth: formatEther(BigInt(prefill.maxCeilingWei)),
            })),
        };
    }
}
