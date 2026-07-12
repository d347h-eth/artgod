import { formatEther } from "viem";
import type { ChainRecord } from "@artgod/shared/types";

// Exact persisted maximum returned by the active bidding ceiling read port.
export type ActiveBiddingJobCeilingMaximum = {
    collectionId: number;
    maxCeilingWei: string;
};

export type ListActiveBiddingJobCeilingsInput = {
    chainRef: string;
};

export type ListActiveBiddingJobCeilingsOutput = {
    chain: ChainRecord;
    ceilings: Array<{
        collectionId: number;
        maxCeilingEth: string;
    }>;
};

// Resolves a chain-wide active ceiling summary into Admin-facing Ether units.
export class ListActiveBiddingJobCeilingsUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string | undefined,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly activeBiddingJobCeilingsReadPort: {
            listActiveCeilingMaxima(params: {
                chainId: number;
            }): ActiveBiddingJobCeilingMaximum[];
        },
    ) {}

    listActiveBiddingJobCeilings(
        input: ListActiveBiddingJobCeilingsInput,
    ): ListActiveBiddingJobCeilingsOutput {
        // Resolve the requested chain before reading its enabled bidding jobs.
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        // Format exact persisted maxima for the Admin WETH input contract.
        const ceilings =
            this.activeBiddingJobCeilingsReadPort.listActiveCeilingMaxima({
                chainId: chain.publicChainId,
            });

        return {
            chain,
            ceilings: ceilings.map((ceiling) => ({
                collectionId: ceiling.collectionId,
                maxCeilingEth: formatEther(BigInt(ceiling.maxCeilingWei)),
            })),
        };
    }
}
