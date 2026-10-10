import { db } from "@artgod/shared/database";
import { bootstrapScopeContainsToken } from "@artgod/shared/bootstrap/scope";
import { normalizeEvmTokenId } from "@artgod/shared/evm/token-id";
import { resolveBootstrapRunScope } from "../../application/bootstrap-token-enumeration.js";
import type { BootstrapRunDefinition } from "../../ports/bootstrap-runs.js";
import type { BootstrapEnumerationConfirmation } from "../../ports/bootstrap-steps.js";
import {
    createContractDeploymentSearchProgress,
    parseContractDeploymentSearchProgress,
} from "@artgod/shared/evm/contract-deployment";
import {
    BOOTSTRAP_STEP_KEY,
    BOOTSTRAP_STEP_STATUS,
    BOOTSTRAP_RUN_STATUS,
    type BootstrapDeploymentStepConfig,
} from "@artgod/shared/bootstrap/pipeline";
import {
    type BootstrapDeploymentClaim,
    type BootstrapDeploymentResult,
    type BootstrapDeploymentStorePort,
    type BootstrapDeploymentSearchProgress,
} from "../../application/bootstrap-deployment-executor.js";

export class SqliteBootstrapDeployment implements BootstrapDeploymentStorePort {
    constructor(private readonly nowMs: () => number = Date.now) {}

    ownsLease(claim: BootstrapDeploymentClaim): boolean {
        return (
            db
                .prepare(
                    "SELECT 1 FROM bootstrap_run_steps s JOIN bootstrap_runs r ON r.run_id = s.run_id " +
                        "JOIN collections c ON c.chain_id = r.chain_id AND c.collection_id = r.collection_id " +
                        "WHERE s.run_id = @runId AND s.step_key = @stepKey AND s.status = @running " +
                        "AND s.lease_owner = @leaseOwner AND s.lease_until > @nowMs " +
                        "AND r.status != @failed " +
                        "AND r.chain_id = @chainId AND r.collection_id = @collectionId AND lower(r.request_address) = lower(@address) " +
                        "AND lower(c.address) = lower(@address)",
                )
                .get(this.params(claim)) !== undefined
        );
    }

    getCollectionDeploymentBlock(
        claim: BootstrapDeploymentClaim,
    ): number | null {
        const row = db
            .prepare(
                "SELECT deployment_block FROM collections WHERE chain_id = @chainId " +
                    "AND collection_id = @collectionId AND lower(address) = lower(@address)",
            )
            .get({
                chainId: claim.chainId,
                collectionId: claim.collectionId,
                address: claim.address,
            }) as { deployment_block: number | null } | undefined;
        return row?.deployment_block ?? null;
    }

    getConfirmedTokenId(run: BootstrapRunDefinition): string | null {
        const row = db
            .prepare(
                "SELECT s.result_json FROM bootstrap_run_steps s JOIN bootstrap_runs r ON r.run_id = s.run_id " +
                    "WHERE s.run_id = @runId AND s.step_key = @stepKey AND s.status = @succeeded " +
                    "AND r.status != @failed AND r.chain_id = @chainId AND r.collection_id = @collectionId " +
                    "AND lower(r.request_address) = lower(@address) " +
                    "AND r.anchor_block = @anchorBlock AND r.anchor_block_hash = @anchorHash",
            )
            .get({
                runId: run.runId,
                stepKey: BOOTSTRAP_STEP_KEY.Enumeration,
                succeeded: BOOTSTRAP_STEP_STATUS.Succeeded,
                failed: BOOTSTRAP_RUN_STATUS.Failed,
                chainId: run.chainId,
                collectionId: run.collectionId,
                address: run.requestAddress,
                anchorBlock: run.anchorBlock,
                anchorHash: run.anchorBlockHash,
            }) as { result_json: string | null } | undefined;
        if (!row?.result_json) return null;
        try {
            const result = JSON.parse(
                row.result_json,
            ) as Partial<BootstrapEnumerationConfirmation> | null;
            const tokenId = normalizeEvmTokenId(result?.firstTokenId);
            if (
                !result ||
                tokenId === null ||
                result.anchorBlock !== run.anchorBlock ||
                result.anchorHash !== run.anchorBlockHash
            )
                return null;
            return bootstrapScopeContainsToken(
                resolveBootstrapRunScope(run),
                tokenId,
            )
                ? tokenId
                : null;
        } catch {
            return null;
        }
    }

    wasSharedContractDetected(runId: number): boolean {
        const row = db
            .prepare(
                "SELECT config_json FROM bootstrap_run_steps WHERE run_id = ? AND step_key = ?",
            )
            .get(runId, BOOTSTRAP_STEP_KEY.DeploymentBlock) as
            | { config_json: string | null }
            | undefined;
        if (!row?.config_json) return false;
        const config = JSON.parse(
            row.config_json,
        ) as BootstrapDeploymentStepConfig | null;
        return config?.sharedContract === true;
    }

    recordSearchRange(
        claim: BootstrapDeploymentClaim,
        range: { fromBlock: number; toBlock: number },
    ): void {
        this.mergeSearchResult(claim, range);
    }

    private mergeSearchResult(
        claim: BootstrapDeploymentClaim,
        result:
            | BootstrapDeploymentSearchProgress
            | { fromBlock: number; toBlock: number },
    ): void {
        db.writeTransaction(() => {
            if (!this.ownsLease(claim)) return;
            db.prepare(
                "UPDATE bootstrap_run_steps SET result_json = json_patch(" +
                    "CASE WHEN json_valid(result_json) AND json_type(result_json) = 'object' THEN result_json ELSE '{}' END, @resultJson), updated_at = CURRENT_TIMESTAMP " +
                    "WHERE run_id = @runId AND step_key = @stepKey AND status = @running " +
                    "AND lease_owner = @leaseOwner AND lease_until > @nowMs " +
                    "AND EXISTS (SELECT 1 FROM bootstrap_runs r WHERE r.run_id = @runId AND r.status != @failed)",
            ).run({
                ...this.params(claim),
                resultJson: JSON.stringify(result),
            });
        })();
    }

    getSearchProgress(runId: number): BootstrapDeploymentSearchProgress | null {
        const row = db
            .prepare(
                "SELECT result_json FROM bootstrap_run_steps WHERE run_id = ? AND step_key = ?",
            )
            .get(runId, BOOTSTRAP_STEP_KEY.DeploymentBlock) as
            | { result_json: string | null }
            | undefined;
        if (!row?.result_json) return null;
        try {
            const progress = JSON.parse(
                row.result_json,
            ) as Partial<BootstrapDeploymentSearchProgress> | null;
            // json_patch removes a null boundary during a fork reset. An absent
            // boundary must trigger another code search, never genesis logs.
            const lowerBlock = progress?.lowerBlock ?? null;
            const firstTokenId = progress?.firstTokenId ?? null;
            const codeSearch =
                lowerBlock === null
                    ? parseContractDeploymentSearchProgress(
                          progress?.codeSearch ??
                              createContractDeploymentSearchProgress(),
                          progress?.upperBlock!,
                      )
                    : null;
            if (
                !progress ||
                (firstTokenId !== null &&
                    (typeof firstTokenId !== "string" ||
                        !/^\d+$/.test(firstTokenId))) ||
                typeof progress.upperBlockHash !== "string" ||
                !/^0x[0-9a-fA-F]{64}$/.test(progress.upperBlockHash) ||
                !Number.isSafeInteger(progress.upperBlock) ||
                progress.upperBlock! < 0 ||
                !Number.isSafeInteger(progress.nextBlock) ||
                progress.nextBlock! < 0 ||
                progress.nextBlock! > progress.upperBlock! + 1 ||
                (lowerBlock !== null &&
                    (!Number.isSafeInteger(lowerBlock) ||
                        lowerBlock < 0 ||
                        lowerBlock > progress.upperBlock!)) ||
                (lowerBlock === null
                    ? progress.nextBlock !== 0 || codeSearch === null
                    : progress.nextBlock! < lowerBlock ||
                      progress.codeSearch != null)
            )
                return null;
            return {
                ...progress,
                firstTokenId,
                lowerBlock,
                codeSearch,
            } as BootstrapDeploymentSearchProgress;
        } catch {
            return null;
        }
    }

    saveSearchProgress(
        claim: BootstrapDeploymentClaim,
        progress: BootstrapDeploymentSearchProgress,
    ): void {
        // Both request diagnostics and the completed-page cursor share the step
        // result. Merge so recording the next request cannot erase the cursor.
        this.mergeSearchResult(claim, progress);
    }

    complete(
        claim: BootstrapDeploymentClaim,
        result: BootstrapDeploymentResult,
    ): boolean {
        return db.writeTransaction(() => {
            // Failure invalidates in-flight lookups, even while their lease is current.
            // Check inside the publication transaction so failure cannot race the write.
            if (!this.ownsLease(claim)) return false;
            const collection = db
                .prepare(
                    "SELECT deployment_block FROM collections WHERE chain_id = @chainId " +
                        "AND collection_id = @collectionId AND lower(address) = lower(@address)",
                )
                .get({
                    chainId: claim.chainId,
                    collectionId: claim.collectionId,
                    address: claim.address,
                }) as { deployment_block: number | null } | undefined;
            if (!collection)
                throw new Error(
                    "Deployment search collection changed or is missing",
                );
            // Preserve a hint supplied while the lookup was in flight.
            const deploymentBlock =
                collection.deployment_block ?? result.deploymentBlock;
            const settled = db
                .prepare(
                    "UPDATE bootstrap_run_steps SET status = @succeeded, progress_completed = 1, progress_total = 1, " +
                        "result_json = @resultJson, lease_owner = NULL, lease_until = NULL, next_attempt_at = 0, " +
                        "last_error = NULL, last_error_at = NULL, finished_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP " +
                        "WHERE run_id = @runId AND step_key = @stepKey AND status = @running " +
                        "AND lease_owner = @leaseOwner AND lease_until > @nowMs",
                )
                .run({
                    ...this.params(claim),
                    succeeded: BOOTSTRAP_STEP_STATUS.Succeeded,
                    resultJson: JSON.stringify({ deploymentBlock }),
                });
            if (settled.changes !== 1) return false;
            db.prepare(
                "UPDATE collections SET deployment_block = @deploymentBlock, updated_at = CURRENT_TIMESTAMP " +
                    "WHERE chain_id = @chainId AND collection_id = @collectionId",
            ).run({
                chainId: claim.chainId,
                collectionId: claim.collectionId,
                deploymentBlock,
            });
            db.prepare(
                "UPDATE bootstrap_runs SET deployment_block = COALESCE(deployment_block, @deploymentBlock), " +
                    "updated_at = CURRENT_TIMESTAMP WHERE run_id = @runId",
            ).run({ runId: claim.runId, deploymentBlock });
            return true;
        })();
    }

    private params(claim: BootstrapDeploymentClaim) {
        return {
            ...claim,
            stepKey: BOOTSTRAP_STEP_KEY.DeploymentBlock,
            running: BOOTSTRAP_STEP_STATUS.Running,
            failed: BOOTSTRAP_RUN_STATUS.Failed,
            nowMs: this.nowMs(),
        };
    }
}
