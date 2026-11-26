import { ReadModelBadRequestError } from "../read-models/errors.js";
import { db } from "./db.js";
import {
    TRAIT_CATALOG_REBUILD_STATUS as STATUS,
    type TraitCatalogRebuild,
} from "../types/trait-catalog.js";

export type TraitCatalogRebuildInput = {
    chainId: number;
    collectionId: number;
    viewId: string;
    mapperVersion: string;
    retryRunId?: number;
};

export function getTraitCatalogRebuild(
    chainId: number,
    collectionId: number,
    runId: number,
): TraitCatalogRebuild | null {
    return (
        (db
            .prepare(
                `
        SELECT r.generation AS runId,r.view_id AS viewId,r.generation,g.mapper_version AS mapperVersion,
               r.status,r.error,
               COALESCE(r.final_total,(SELECT COUNT(*) FROM trait_catalog_members m WHERE m.chain_id=r.chain_id
                     AND m.collection_id=r.collection_id AND m.view_id=r.view_id)) AS total,
               COALESCE(r.final_total,(SELECT COUNT(*) FROM trait_catalog_projections p WHERE p.chain_id=r.chain_id
                     AND p.collection_id=r.collection_id AND p.view_id=r.view_id AND p.generation=r.generation)) AS processed
        FROM trait_catalog_rebuilds r JOIN trait_catalog_generations g USING(generation)
        WHERE r.chain_id=? AND r.collection_id=? AND r.generation=?
    `,
            )
            .get(chainId, collectionId, runId) as
            | TraitCatalogRebuild
            | undefined) ?? null
    );
}

/** Serialize starts and retries with both source writes and the worker's publication transaction. */
export function requestTraitCatalogRebuild(
    input: TraitCatalogRebuildInput,
): TraitCatalogRebuild {
    return db.writeTransaction(() => {
        const { chainId, collectionId, viewId, mapperVersion, retryRunId } =
            input;
        const scope = [chainId, collectionId, viewId] as const;
        const view = db
            .prepare(
                `
            SELECT v.active_generation FROM trait_catalog_views v JOIN collection_extension_installs i USING(chain_id,collection_id)
            WHERE v.chain_id=? AND v.collection_id=? AND v.view_id=? AND i.enabled=1
        `,
            )
            .get(...scope) as { active_generation: number } | undefined;
        if (!view)
            throw new ReadModelBadRequestError(
                "Unknown or disabled collection view",
            );
        const latest = db
            .prepare(
                `
            SELECT generation FROM trait_catalog_rebuilds WHERE chain_id=? AND collection_id=? AND view_id=?
            ORDER BY generation DESC LIMIT 1
        `,
            )
            .get(...scope) as { generation: number } | undefined;
        const current =
            latest &&
            getTraitCatalogRebuild(chainId, collectionId, latest.generation)!;
        if (
            retryRunId !== undefined &&
            (current?.runId !== retryRunId ||
                current.mapperVersion !== mapperVersion ||
                current.status === STATUS.Completed)
        )
            throw new ReadModelBadRequestError(
                "Rebuild retry does not match the current run",
            );
        if (current?.status === STATUS.Running) {
            if (current.mapperVersion !== mapperVersion)
                throw new ReadModelBadRequestError(
                    "A different mapper rebuild is running",
                );
            return current;
        }
        let generation: number;
        if (retryRunId !== undefined) {
            generation = retryRunId;
            db.prepare(
                "UPDATE trait_catalog_rebuilds SET status=?,error=NULL WHERE generation=?",
            ).run(STATUS.Running, generation);
            db.prepare(
                "UPDATE trait_catalog_work SET due_at=0,lease_owner=NULL,error=NULL WHERE generation=?",
            ).run(generation);
        } else {
            if (current?.status === STATUS.Failed) {
                // A replacement version supersedes failed work. The failure remains inspectable.
                db.prepare(
                    "UPDATE trait_catalog_generations SET cleanup_pending=1 WHERE generation=?",
                ).run(current.generation);
            }
            generation = Number(
                db
                    .prepare(
                        "INSERT INTO trait_catalog_generations(chain_id,collection_id,view_id,mapper_version) VALUES(?,?,?,?)",
                    )
                    .run(...scope, mapperVersion).lastInsertRowid,
            );
            db.prepare(
                "INSERT INTO trait_catalog_rebuilds(chain_id,collection_id,view_id,generation,status) VALUES(?,?,?,?,?)",
            ).run(...scope, generation, STATUS.Running);
        }
        return getTraitCatalogRebuild(chainId, collectionId, generation)!;
    })();
}
