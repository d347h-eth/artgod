import { createPublicClient, http } from "viem";
import { getEnsAddress } from "viem/actions";
import { normalize } from "viem/ens";

const ENS_UNIVERSAL_RESOLVER_ADDRESS =
    "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";

export class ViemBackendRpcClient {
    private readonly client;

    constructor(rpcUrl: string) {
        this.client = createPublicClient({
            transport: http(rpcUrl),
        });
    }

    async resolveEnsAddress(name: string): Promise<string | null> {
        const normalizedName = normalize(name.trim());
        const resolvedAddress = await getEnsAddress(this.client, {
            name: normalizedName,
            universalResolverAddress: ENS_UNIVERSAL_RESOLVER_ADDRESS,
        });
        if (!resolvedAddress) {
            return null;
        }
        return resolvedAddress.toLowerCase();
    }
}
