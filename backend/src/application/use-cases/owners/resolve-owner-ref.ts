import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import type { ChainRecord } from "@artgod/shared/types/browse";
import {
    isAddressRef,
    isEnsNameRef,
    normalizeAddressRef,
    normalizeEnsNameRef,
} from "@artgod/shared/utils/ref-resolver";

const ENS_PUBLIC_CHAIN_ID = 1;

export type ResolveOwnerRefInput = {
    chainRef: string;
    value: string;
};

export type ResolveOwnerRefOutput = {
    input: string;
    resolvedAddress: string;
};

export class ResolveOwnerRefUseCase {
    constructor(
        readonly defaultChainId: number,
        readonly chainRefResolverPort: {
            resolveChainRef(
                chainRef: string,
                defaultPublicChainId: number,
            ): ChainRecord;
        },
        readonly ownerRefResolutionPort: {
            resolveEnsAddress(name: string): Promise<string | null>;
        },
    ) {}

    async resolveOwnerRef(
        input: ResolveOwnerRefInput,
    ): Promise<ResolveOwnerRefOutput> {
        const chain = this.chainRefResolverPort.resolveChainRef(
            input.chainRef,
            this.defaultChainId,
        );
        const value = input.value.trim();
        if (!value) {
            throw new ReadModelBadRequestError("Invalid owner ref");
        }
        if (isAddressRef(value)) {
            return {
                input: value,
                resolvedAddress: normalizeAddressRef(value),
            };
        }
        if (!isEnsNameRef(value)) {
            throw new ReadModelBadRequestError("Invalid owner ref");
        }
        if (chain.publicChainId !== ENS_PUBLIC_CHAIN_ID) {
            throw new ReadModelBadRequestError(
                "ENS resolution is only supported on Ethereum mainnet",
            );
        }

        const resolvedAddress =
            await this.ownerRefResolutionPort.resolveEnsAddress(
                normalizeEnsNameRef(value),
            );
        if (!resolvedAddress) {
            throw new ReadModelNotFoundError("ENS name not found");
        }

        return {
            input: value,
            resolvedAddress: normalizeAddressRef(resolvedAddress),
        };
    }
}
