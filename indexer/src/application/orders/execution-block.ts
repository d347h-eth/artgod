import { tryParseHash } from "@artgod/shared/offchain/normalizer-utils";
import type { RpcProviderPort } from "../../ports/rpc.js";

export const ORDER_EXECUTION_LOG = {
    Component: "OrderExecution",
    MissingTransactionHash:
        "Ignoring source execution validation without a valid transaction hash",
} as const;

/** Publish partial/unknown-order checks durably before acknowledging a source sale.
 * No receipt RPC runs in the order-lifecycle-updates consumer. */
export interface SourceExecutionValidationPort {
    request(input: {
        chainId: number;
        orderId: string;
        transactionHash: string;
        /** Original observation time in milliseconds identifies handoff retries;
         * canonical transaction inclusion, not this clock, defines validation coverage. */
        requiredAt: number;
    }): Promise<void>;
}

/** A source execution becomes a block requirement only after checking its current
 * canonical inclusion. The order-updates-by-id delivery owns the obligation until
 * this succeeds and ordinary validation demand has been admitted. */
export interface OrderExecutionBlockPort {
    resolve(transactionHash: string): Promise<number>;
}

export class CanonicalOrderExecutionBlock implements OrderExecutionBlockPort {
    constructor(
        private readonly rpc: Pick<
            RpcProviderPort,
            "getTransactionReceipt" | "getBlock"
        >,
    ) {}

    async resolve(transactionHash: string): Promise<number> {
        if (!tryParseHash(transactionHash))
            throw new Error("Execution coverage requires a transaction hash");
        const receipt = await this.rpc.getTransactionReceipt(transactionHash, {
            fresh: true,
        });
        if (
            receipt.transactionHash.toLowerCase() !==
                transactionHash.toLowerCase() ||
            !Number.isSafeInteger(receipt.blockNumber) ||
            receipt.blockNumber < 0 ||
            !tryParseHash(receipt.blockHash)
        )
            throw new Error("Execution receipt has no valid block attribution");
        const block = await this.rpc.getBlock(receipt.blockNumber, {
            fresh: true,
        });
        if (
            block.number !== receipt.blockNumber ||
            block.hash.toLowerCase() !== receipt.blockHash.toLowerCase() ||
            !block.transactions.some(
                (hash) => hash.toLowerCase() === transactionHash.toLowerCase(),
            )
        )
            throw new Error("Execution receipt is not in its canonical block");
        return receipt.blockNumber;
    }
}
