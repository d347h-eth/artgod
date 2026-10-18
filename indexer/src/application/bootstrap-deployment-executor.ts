import {
    createContractDeploymentSearchProgress,
    findContractDeploymentBlock,
    type ContractDeploymentRpcPort,
    type ContractDeploymentSearchProgress,
} from "@artgod/shared/evm/contract-deployment";
import { RpcRequestCancelledError } from "@artgod/shared/evm/rpc-errors";
import { BOOTSTRAP_ENUMERATION_MODE } from "@artgod/shared/bootstrap/pipeline";
import type { BootstrapRunDefinition } from "../ports/bootstrap-runs.js";
import type { BootstrapEnumerationConfirmation } from "../ports/bootstrap-steps.js";
import { zeroAddress } from "viem";
import { ERC721_ABI } from "../abi/index.js";
import type { RpcBlock, RpcFirstLogPort } from "../ports/rpc.js";
import { resolveBootstrapAnchorBlock } from "./bootstrap-anchor-plan.js";
import { resolveBootstrapRunScope } from "./bootstrap-token-enumeration.js";

export type BootstrapDeploymentResult = {
    deploymentBlock: number;
};

// The code boundary and verified empty prefix belong to one token and chain
// snapshot. No log page is requested until lowerBlock has been found; nextBlock
// advances only after that exact page succeeds.
export type BootstrapDeploymentSearchProgress = {
    firstTokenId: string | null;
    upperBlock: number;
    upperBlockHash: `0x${string}`;
    lowerBlock: number | null;
    codeSearch: ContractDeploymentSearchProgress | null;
    nextBlock: number;
};

export type BootstrapDeploymentClaim = {
    runId: number;
    chainId: number;
    collectionId: number;
    address: string;
    leaseOwner: string;
    // Inferred mint work is valid only while this exact run-owned input remains.
    confirmation?: BootstrapEnumerationConfirmation;
};

export interface BootstrapDeploymentRpcPort
    extends ContractDeploymentRpcPort, RpcFirstLogPort {
    getBlockNumber(beforeRequest?: () => void): Promise<number>;
    getBlock(
        blockNumber: number,
        options: { fresh: boolean; beforeRequest?: () => void },
    ): Promise<RpcBlock>;
}

export interface BootstrapDeploymentStorePort {
    ownsLease(claim: BootstrapDeploymentClaim): boolean;
    getCollectionDeploymentBlock(
        claim: BootstrapDeploymentClaim,
    ): number | null;
    // Only enumeration's retained, anchor-bound output from this run is input.
    getEnumerationConfirmation(
        run: BootstrapRunDefinition,
    ): BootstrapEnumerationConfirmation | null;
    wasSharedContractDetected(runId: number): boolean;
    getSearchProgress(runId: number): BootstrapDeploymentSearchProgress | null;
    saveSearchProgress(
        claim: BootstrapDeploymentClaim,
        progress: BootstrapDeploymentSearchProgress,
    ): void;
    recordSearchRange(
        claim: BootstrapDeploymentClaim,
        range: { fromBlock: number; toBlock: number },
    ): void;
    // Atomically fill collection/run hints and settle the step, fenced by its
    // running status, unexpired lease, owner, collection contract identity and
    // (for mint searches) the exact enumeration confirmation in the claim.
    complete(
        claim: BootstrapDeploymentClaim,
        result: BootstrapDeploymentResult,
    ): boolean;
}

class DeploymentLeaseLost extends RpcRequestCancelledError {}

// Independent enrichment: neither collection liveness nor run completion waits
// for this executor. Errors use the scheduler's existing durable retry policy.
export class BootstrapDeploymentExecutor {
    constructor(
        private readonly rpc: BootstrapDeploymentRpcPort,
        private readonly store: BootstrapDeploymentStorePort,
    ) {}

    async search(input: {
        run: BootstrapRunDefinition;
        leaseOwner: string;
        reorgDepth: number;
    }): Promise<boolean> {
        const { run } = input;
        const claim: BootstrapDeploymentClaim = {
            runId: run.runId,
            chainId: run.chainId,
            collectionId: run.collectionId,
            address: run.requestAddress,
            leaseOwner: input.leaseOwner,
        };
        if (!this.store.ownsLease(claim)) return false;
        const assertLease = () => {
            if (!this.store.ownsLease(claim)) throw new DeploymentLeaseLost();
        };
        const read = async <T>(call: () => Promise<T>): Promise<T> => {
            assertLease();
            return call();
        };
        const recordSearchRange = (range: {
            fromBlock: number;
            toBlock: number;
        }) => {
            assertLease();
            this.store.recordSearchRange(claim, range);
        };
        const complete = (deploymentBlock: number) =>
            this.store.complete(claim, { deploymentBlock });

        try {
            const provided =
                run.deploymentBlock ??
                this.store.getCollectionDeploymentBlock(claim);
            if (provided !== null) return complete(provided);

            const scope = resolveBootstrapRunScope(run);
            const useMintEvents =
                scope.mode !== BOOTSTRAP_ENUMERATION_MODE.Enumerable ||
                this.store.wasSharedContractDetected(run.runId);
            const confirmation = useMintEvents
                ? this.store.getEnumerationConfirmation(run)
                : null;
            // All mint methods wait for this run's confirmed token, including
            // lists whose first declared candidate may be absent at the anchor.
            if (useMintEvents && confirmation === null) return false;
            if (confirmation) claim.confirmation = confirmation;
            const firstTokenId = confirmation?.firstTokenId ?? null;

            // Start without waiting for the main lane's anchor. Prefer an already
            // selected anchor; otherwise independently select a settled upper bound.
            const savedProgress = this.store.getSearchProgress(run.runId);
            let progress =
                savedProgress?.firstTokenId === firstTokenId &&
                (!confirmation ||
                    (savedProgress.upperBlock === confirmation.anchorBlock &&
                        savedProgress.upperBlockHash ===
                            confirmation.anchorHash))
                    ? savedProgress
                    : null;
            const upperBlock =
                progress?.upperBlock ??
                run.anchorBlock ??
                resolveBootstrapAnchorBlock({
                    headBlock: await read(() =>
                        this.rpc.getBlockNumber(assertLease),
                    ),
                    reorgDepth: input.reorgDepth,
                });
            if (upperBlock === null)
                throw new Error("Deployment search upper block is invalid");
            let upperBlockHash = progress?.upperBlockHash;
            if (
                !upperBlockHash ||
                (confirmation && progress?.codeSearch?.presentBlock === null)
            ) {
                const before = await read(() =>
                    this.rpc.getBlock(upperBlock, {
                        fresh: true,
                        beforeRequest: assertLease,
                    }),
                );
                if (
                    upperBlock === run.anchorBlock &&
                    run.anchorBlockHash &&
                    before.hash !== run.anchorBlockHash
                )
                    throw new Error("Deployment search anchor changed");
                upperBlockHash = before.hash;
            }
            progress ??= {
                firstTokenId,
                upperBlock,
                upperBlockHash,
                lowerBlock: null,
                codeSearch: createContractDeploymentSearchProgress(),
                nextBlock: 0,
            };
            assertLease();
            this.store.saveSearchProgress(claim, progress);
            if (progress.lowerBlock === null) {
                const startingProgress = progress;
                const lowerBlock = await findContractDeploymentBlock({
                    rpc: {
                        getBytecode: (address, block) => {
                            recordSearchRange({
                                fromBlock: block,
                                toBlock: block,
                            });
                            return this.rpc.getBytecode(
                                address,
                                block,
                                assertLease,
                            );
                        },
                    },
                    address: run.requestAddress as `0x${string}`,
                    upperBlock,
                    progress:
                        startingProgress.codeSearch ??
                        createContractDeploymentSearchProgress(),
                    onProgress: (codeSearch) => {
                        assertLease();
                        this.store.saveSearchProgress(claim, {
                            ...startingProgress,
                            codeSearch,
                        });
                    },
                });
                assertLease();
                progress = {
                    ...startingProgress,
                    lowerBlock,
                    nextBlock: lowerBlock,
                    codeSearch: null,
                };
                this.store.saveSearchProgress(claim, progress);
            }
            let deploymentBlock: number | undefined =
                progress.lowerBlock ?? undefined;
            if (firstTokenId !== null) {
                const page = await this.rpc.findFirstLogPage(
                    {
                        address: run.requestAddress as `0x${string}`,
                        event: ERC721_ABI[0],
                        args: {
                            from: zeroAddress,
                            tokenId: BigInt(firstTokenId),
                        },
                        fromBlock: progress.nextBlock,
                        toBlock: upperBlock,
                    },
                    {
                        beforeRequest: assertLease,
                        onRequest: recordSearchRange,
                    },
                );
                assertLease();
                if (!page.log) {
                    deploymentBlock = undefined;
                    progress = { ...progress, nextBlock: page.nextBlock };
                    this.store.saveSearchProgress(claim, progress);
                    if (page.nextBlock <= upperBlock) return false;
                } else deploymentBlock = page.log.blockNumber;
            }
            const after = await read(() =>
                this.rpc.getBlock(upperBlock, {
                    fresh: true,
                    beforeRequest: assertLease,
                }),
            );
            if (upperBlockHash !== after.hash) {
                // A fork invalidates the code boundary and empty prefix. Mint
                // selection still belongs to enumeration's original history:
                // retry must check that anchor again, never adopt the new hash.
                if (progress)
                    this.store.saveSearchProgress(claim, {
                        ...progress,
                        upperBlockHash: confirmation
                            ? progress.upperBlockHash
                            : after.hash,
                        lowerBlock: null,
                        codeSearch: createContractDeploymentSearchProgress(),
                        nextBlock: 0,
                    });
                throw new Error("Deployment search chain changed");
            }
            if (deploymentBlock === undefined)
                throw new Error("First token mint was not found");
            return complete(deploymentBlock);
        } catch (error) {
            // Pause, deletion, or another owner taking over ends this attempt.
            // In particular, a late RPC rejection must not replace a paused step.
            if (
                error instanceof DeploymentLeaseLost ||
                !this.store.ownsLease(claim)
            )
                return false;
            throw error;
        }
    }
}
