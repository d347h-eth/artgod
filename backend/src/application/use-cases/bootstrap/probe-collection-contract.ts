import type {
    BootstrapContractFindings,
    BootstrapContractProbeResponse,
} from "@artgod/shared/bootstrap/probe";
import type { ChainRefResolverPort } from "./ports.js";
import { BootstrapValidationError } from "./types.js";

export type ProbeCollectionContractInput = {
    chainRef: string;
    address: string;
    standard: "erc721";
};
export type ProbeCollectionContractOutput = BootstrapContractProbeResponse;
export interface CollectionContractProbePort {
    discoverContract(address: string): Promise<BootstrapContractFindings>;
}

/** Contract discovery has no sample, metadata or selected-scope dependency. */
export class ProbeCollectionContractUseCase {
    constructor(
        private readonly defaultChainId: number,
        private readonly chainRefResolverPort: ChainRefResolverPort,
        private readonly collectionContractProbePort: CollectionContractProbePort,
    ) {}

    async probe(
        input: ProbeCollectionContractInput,
    ): Promise<ProbeCollectionContractOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        if (input.standard !== "erc721")
            throw new BootstrapValidationError("Only erc721 is supported");
        const address = normalizeBootstrapProbeAddress(input.address);
        return {
            ...(await this.collectionContractProbePort.discoverContract(
                address,
            )),
            chain,
            address,
            standard: input.standard,
        };
    }
}

export function normalizeBootstrapProbeAddress(raw: string): string {
    const value = raw.trim().toLowerCase();
    if (!/^0x[a-f0-9]{40}$/.test(value))
        throw new BootstrapValidationError("Invalid address");
    return value;
}
