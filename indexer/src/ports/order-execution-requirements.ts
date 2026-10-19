import type { ChainSyncCheckpoint } from "../domain/chain-sync.js";
import type { SourceExecutionValidationPort } from "../application/orders/execution-block.js";

export type OrderExecutionRequirement = Parameters<
    SourceExecutionValidationPort["request"]
>[0];
export type ClaimedOrderExecution = OrderExecutionRequirement & {
    leaseOwner: string;
    leaseVersion: number;
    failures: number;
};

/** Receipt resolution and validation demand share a transactional handoff. */
export interface OrderExecutionRequirementsPort extends SourceExecutionValidationPort {
    captureSyncCheckpoint(chainId: number): ChainSyncCheckpoint;
    claim(
        chainId: number,
        owner: string,
        now: number,
    ): ClaimedOrderExecution | null;
    renew(claim: ClaimedOrderExecution, now: number): void;
    complete(
        claim: ClaimedOrderExecution,
        blockNumber: number,
        checkpoint: ChainSyncCheckpoint,
        now: number,
    ): void;
    defer(claim: ClaimedOrderExecution, error: unknown, now: number): void;
    release(claim: ClaimedOrderExecution, now: number): void;
}
