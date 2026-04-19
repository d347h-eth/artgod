import { getAddress, type Address } from "viem";
import type { MakerWethBalanceService } from "../../application/use-cases/bidding/maker-weth-balance-service.js";

const erc20BalanceOfAbi = [
    {
        type: "function",
        stateMutability: "view",
        name: "balanceOf",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "balance", type: "uint256" }],
    },
] as const;

type ReadContractClient = {
    readContract(args: {
        address: Address;
        abi: typeof erc20BalanceOfAbi;
        functionName: "balanceOf";
        args: [Address];
    }): Promise<bigint>;
};

// Reads current maker WETH balance through a viem-compatible public client.
export class ViemMakerWethBalanceService implements MakerWethBalanceService {
    private readonly wethAddress: Address;

    constructor(
        private readonly client: ReadContractClient,
        wethAddress: string,
    ) {
        this.wethAddress = getAddress(wethAddress);
    }

    public async getWethBalance(address: string): Promise<bigint> {
        return await this.client.readContract({
            address: this.wethAddress,
            abi: erc20BalanceOfAbi,
            functionName: "balanceOf",
            args: [getAddress(address)],
        });
    }
}
