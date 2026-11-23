import { randomUUID } from "node:crypto";
import { db } from "@artgod/shared/database";
import { readCanonicalTokenTraits } from "@artgod/shared/database/canonical-traits";
import type { TraitFilter } from "@artgod/shared/types/browse";
import {
    TRAIT_CATALOG_REBUILD_STATUS as STATUS,
    type CollectionViewDescriptor,
    type TraitProjection,
    type TraitCatalogMapper,
} from "@artgod/shared/types/trait-catalog";
import type {
    CatalogMapperResolver,
    CatalogToken,
    ProjectionClaim,
    TraitProjectionStore,
} from "../../application/collection-extensions/trait-catalog.js";

const PAGE_SIZE = 128;
const LEASE_MS = 60_000;
const RETRY_MS = 30_000;

export class SqliteTraitCatalog implements TraitProjectionStore {
    constructor(private readonly resolve: CatalogMapperResolver) {}

    /** Called inside the accepted canonical write, after replacing its links. */
    replaceCanonical(
        token: CatalogToken,
        traits: readonly TraitFilter[],
    ): void {
        const { chainId, collectionId, tokenId } = token;
        const mapper = this.resolve(chainId, collectionId);
        // Cascading replacement immediately removes obsolete links, staged work and leases.
        db.prepare(
            "DELETE FROM trait_catalog_members WHERE chain_id=? AND collection_id=? AND token_id=?",
        ).run(chainId, collectionId, tokenId);
        if (!mapper) return;
        const { revision } = db
            .prepare(
                `
          INSERT INTO trait_catalog_clocks(chain_id,collection_id,revision) VALUES(?,?,1)
          ON CONFLICT(chain_id,collection_id) DO UPDATE SET revision=revision+1 RETURNING revision
        `,
            )
            .get(chainId, collectionId) as { revision: number };
        db.prepare(
            "INSERT INTO trait_catalog_members(chain_id,collection_id,token_id,revision) VALUES(?,?,?,?)",
        ).run(chainId, collectionId, tokenId, revision);
        this.classify(mapper, token, revision, traits, Date.now());
    }

    private classify(
        mapper: TraitCatalogMapper,
        token: CatalogToken,
        revision: number,
        traits: readonly TraitFilter[],
        now: number,
    ): void {
        const { chainId, collectionId, tokenId } = token;
        let view: CollectionViewDescriptor;
        let errorMessage: string | null = null;
        try {
            view = mapper.classify(traits);
        } catch (error) {
            view = mapper.unclassified;
            errorMessage = String(error);
        }
        let version: string;
        try {
            version = mapper.availableVersion(view);
        } catch (error) {
            db.prepare(
                "UPDATE trait_catalog_members SET classification_error=?,retry_at=? WHERE chain_id=? AND collection_id=? AND token_id=? AND revision=?",
            ).run(
                String(error),
                now + RETRY_MS,
                chainId,
                collectionId,
                tokenId,
                revision,
            );
            return;
        }
        const scope = [chainId, collectionId, view.id] as const;
        const created = db
            .prepare(
                `
          INSERT INTO trait_catalog_views(chain_id,collection_id,view_id,descriptor_json) VALUES(?,?,?,?)
          ON CONFLICT(chain_id,collection_id,view_id) DO NOTHING
        `,
            )
            .run(...scope, JSON.stringify(view));
        if (created.changes) {
            const generation = db
                .prepare(
                    "INSERT INTO trait_catalog_generations(chain_id,collection_id,view_id,mapper_version) VALUES(?,?,?,?)",
                )
                .run(...scope, version).lastInsertRowid;
            db.prepare(
                "UPDATE trait_catalog_views SET active_generation=? WHERE chain_id=? AND collection_id=? AND view_id=?",
            ).run(generation, ...scope);
        }
        db.prepare(
            "UPDATE trait_catalog_members SET view_id=?,scope_key=?,classification_error=?,retry_at=? WHERE chain_id=? AND collection_id=? AND token_id=? AND revision=?",
        ).run(
            view.id,
            view.pinnedTraits[0]?.key ?? null,
            errorMessage,
            errorMessage ? now + RETRY_MS : null,
            chainId,
            collectionId,
            tokenId,
            revision,
        );
        if (errorMessage) return;
        db.prepare(
            `
          INSERT INTO trait_catalog_work(chain_id,collection_id,view_id,generation,token_id,revision)
          SELECT chain_id,collection_id,view_id,active_generation,?,? FROM trait_catalog_views WHERE chain_id=? AND collection_id=? AND view_id=?
          UNION ALL SELECT chain_id,collection_id,view_id,generation,?,? FROM trait_catalog_rebuilds WHERE chain_id=? AND collection_id=? AND view_id=? AND status=?
        `,
        ).run(
            tokenId,
            revision,
            ...scope,
            tokenId,
            revision,
            ...scope,
            STATUS.Running,
        );
    }

    retryClassification(chainId: number, now: number): boolean {
        const select = db.prepare(`
            SELECT collection_id AS collectionId,token_id AS tokenId,revision FROM trait_catalog_members m
            JOIN collection_extension_installs i USING(chain_id,collection_id)
            WHERE chain_id=? AND retry_at<=? AND i.enabled=1 ORDER BY retry_at LIMIT 1
        `);
        if (!select.get(chainId, now)) return false;
        return db.writeTransaction(() => {
            const row = select.get(chainId, now) as
                | { collectionId: number; tokenId: string; revision: number }
                | undefined;
            if (!row) return false;
            const mapper = this.resolve(chainId, row.collectionId);
            if (!mapper) return false;
            this.classify(
                mapper,
                { ...row, chainId },
                row.revision,
                readCanonicalTokenTraits(
                    chainId,
                    row.collectionId,
                    row.tokenId,
                ),
                now,
            );
            return true;
        })();
    }

    claim(chainId: number, now: number): ProjectionClaim | null {
        const select = db.prepare(`
            SELECT w.collection_id AS collectionId,w.token_id AS tokenId,w.revision,w.generation,
                   g.mapper_version AS mapperVersion,v.descriptor_json AS descriptor
            FROM trait_catalog_work w JOIN trait_catalog_generations g USING(generation)
            JOIN trait_catalog_views v USING(chain_id,collection_id,view_id)
            JOIN collection_extension_installs i USING(chain_id,collection_id)
            LEFT JOIN trait_catalog_rebuilds r ON r.generation=w.generation
            WHERE w.chain_id=? AND w.due_at<=? AND i.enabled=1 AND (w.generation=v.active_generation OR r.status=?)
            ORDER BY w.due_at,w.rowid LIMIT 1
        `);
        if (!select.get(chainId, now, STATUS.Running)) return null;
        return db.writeTransaction(() => {
            const row = select.get(chainId, now, STATUS.Running) as
                | (Omit<
                      ProjectionClaim,
                      "owner" | "traits" | "view" | "chainId"
                  > & { descriptor: string })
                | undefined;
            if (!row) return null;
            const owner = randomUUID();
            db.prepare(
                "UPDATE trait_catalog_work SET lease_owner=?,due_at=? WHERE generation=? AND token_id=?",
            ).run(owner, now + LEASE_MS, row.generation, row.tokenId);
            return {
                ...row,
                chainId,
                owner,
                view: JSON.parse(row.descriptor) as CollectionViewDescriptor,
                traits: readCanonicalTokenTraits(
                    chainId,
                    row.collectionId,
                    row.tokenId,
                ),
            };
        })();
    }

    private owns(claim: ProjectionClaim): boolean {
        return Boolean(
            db
                .prepare(
                    `
            SELECT 1 FROM trait_catalog_work w JOIN collection_extension_installs i USING(chain_id,collection_id)
            JOIN trait_catalog_views v USING(chain_id,collection_id,view_id)
            LEFT JOIN trait_catalog_rebuilds r ON r.generation=w.generation
            WHERE w.generation=? AND w.token_id=? AND w.revision=? AND w.lease_owner=? AND i.enabled=1
            AND (v.active_generation=w.generation OR r.status=?)
        `,
                )
                .get(
                    claim.generation,
                    claim.tokenId,
                    claim.revision,
                    claim.owner,
                    STATUS.Running,
                ),
        );
    }

    finish(claim: ProjectionClaim, output: TraitProjection): void {
        db.writeTransaction(() => {
            if (!this.owns(claim)) return;
            const scope = [
                claim.chainId,
                claim.collectionId,
                claim.view.id,
                claim.generation,
                claim.tokenId,
            ] as const;
            db.prepare(
                "INSERT INTO trait_catalog_projections(chain_id,collection_id,view_id,generation,token_id,revision,tree_json) VALUES(?,?,?,?,?,?,?)",
            ).run(...scope, claim.revision, JSON.stringify(output.tree));
            const insert = db.prepare(
                "INSERT INTO trait_catalog_values(chain_id,collection_id,view_id,generation,token_id,field_id,label,value,native_field_key,native_key,native_value) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            );
            for (const leaf of output.values)
                insert.run(
                    ...scope,
                    leaf.fieldId,
                    leaf.label,
                    leaf.value,
                    leaf.nativeFieldKey ?? null,
                    leaf.native?.key ?? null,
                    leaf.native?.value ?? null,
                );
            db.prepare(
                "DELETE FROM trait_catalog_work WHERE generation=? AND token_id=?",
            ).run(claim.generation, claim.tokenId);
        })();
    }

    fail(claim: ProjectionClaim, error: string, now: number): void {
        db.writeTransaction(() => {
            if (!this.owns(claim)) return;
            db.prepare(
                "UPDATE trait_catalog_work SET error=?,due_at=?,lease_owner=NULL WHERE generation=? AND token_id=?",
            ).run(error, now + RETRY_MS, claim.generation, claim.tokenId);
            db.prepare(
                "UPDATE trait_catalog_rebuilds SET status=?,error=? WHERE generation=? AND status=?",
            ).run(STATUS.Failed, error, claim.generation, STATUS.Running);
        })();
    }

    advanceRebuild(chainId: number): boolean {
        // Page enumeration, scheduling and cursor update have one commit. All
        // workers can resume it without owning a long-lived enumeration lease.
        const select = db.prepare(`
            SELECT r.collection_id AS collectionId,r.view_id AS viewId,r.generation,r.cursor,r.enumerated
            FROM trait_catalog_rebuilds r JOIN collection_extension_installs i USING(chain_id,collection_id)
            WHERE r.chain_id=? AND status=? AND i.enabled=1 AND
            (r.enumerated=0 OR (NOT EXISTS(SELECT 1 FROM trait_catalog_work w WHERE w.generation=r.generation)
                 AND NOT EXISTS(SELECT 1 FROM trait_catalog_members m WHERE m.chain_id=r.chain_id AND m.collection_id=r.collection_id AND m.view_id=r.view_id AND m.retry_at IS NOT NULL)))
            ORDER BY r.generation LIMIT 1
        `);
        if (!select.get(chainId, STATUS.Running)) return false;
        return db.writeTransaction(() => {
            const run = select.get(chainId, STATUS.Running) as
                | {
                      collectionId: number;
                      viewId: string;
                      generation: number;
                      cursor: string;
                      enumerated: number;
                  }
                | undefined;
            if (!run) return false;
            const scope = [chainId, run.collectionId, run.viewId] as const;
            const page = db
                .prepare(
                    `
                SELECT m.token_id,m.revision FROM trait_catalog_members m
                WHERE m.retry_at IS NULL AND m.chain_id=? AND m.collection_id=? AND m.view_id=? AND m.token_id>?
                AND NOT EXISTS(SELECT 1 FROM trait_catalog_projections p WHERE p.chain_id=m.chain_id AND p.collection_id=m.collection_id
                    AND p.view_id=m.view_id AND p.token_id=m.token_id AND p.generation=? AND p.revision=m.revision)
                ORDER BY m.token_id LIMIT ?
            `,
                )
                .all(
                    ...scope,
                    run.enumerated ? "" : run.cursor,
                    run.generation,
                    PAGE_SIZE,
                ) as { token_id: string; revision: number }[];
            if (page.length) {
                const insert = db.prepare(`
                    INSERT INTO trait_catalog_work(chain_id,collection_id,view_id,generation,token_id,revision) VALUES(?,?,?,?,?,?)
                    ON CONFLICT(generation,token_id) DO NOTHING
                `);
                for (const row of page)
                    insert.run(
                        ...scope,
                        run.generation,
                        row.token_id,
                        row.revision,
                    );
                db.prepare(
                    "UPDATE trait_catalog_rebuilds SET cursor=?,enumerated=? WHERE generation=?",
                ).run(
                    page.at(-1)!.token_id,
                    Number(page.length < PAGE_SIZE),
                    run.generation,
                );
                return true;
            }
            if (!run.enumerated) {
                db.prepare(
                    "UPDATE trait_catalog_rebuilds SET enumerated=1 WHERE generation=?",
                ).run(run.generation);
                return true;
            }
            // Under the writer lock every current member has a same-revision projection.
            // Preserve a completed run's outcome while removing obsolete links and work.
            const { active_generation: old } = db
                .prepare(
                    "SELECT active_generation FROM trait_catalog_views WHERE chain_id=? AND collection_id=? AND view_id=?",
                )
                .get(...scope) as { active_generation: number };
            db.prepare(
                "UPDATE trait_catalog_views SET active_generation=? WHERE chain_id=? AND collection_id=? AND view_id=?",
            ).run(run.generation, ...scope);
            db.prepare(
                `UPDATE trait_catalog_rebuilds SET status=?,final_total=(SELECT COUNT(*) FROM trait_catalog_members WHERE chain_id=? AND collection_id=? AND view_id=?) WHERE generation=?`,
            ).run(STATUS.Completed, ...scope, run.generation);
            db.prepare(
                "UPDATE trait_catalog_generations SET cleanup_pending=1 WHERE generation=?",
            ).run(old);
            return true;
        })();
    }

    /** Keep old-generation deletion out of the publication lock and resume it after restart. */
    cleanupRetired(chainId: number): boolean {
        const select = db.prepare(
            "SELECT collection_id AS collectionId,view_id AS viewId,generation FROM trait_catalog_generations WHERE chain_id=? AND cleanup_pending=1 ORDER BY generation LIMIT 1",
        );
        if (!select.get(chainId)) return false;
        return db.writeTransaction(() => {
            const old = select.get(chainId) as
                | { collectionId: number; viewId: string; generation: number }
                | undefined;
            if (!old) return false;
            const scope = [
                chainId,
                old.collectionId,
                old.viewId,
                old.generation,
            ] as const;
            const removedWork = db
                .prepare(
                    "DELETE FROM trait_catalog_work WHERE rowid IN (SELECT rowid FROM trait_catalog_work WHERE generation=? LIMIT ?)",
                )
                .run(old.generation, PAGE_SIZE);
            const removedTrees = db
                .prepare(
                    "DELETE FROM trait_catalog_projections WHERE rowid IN (SELECT rowid FROM trait_catalog_projections WHERE chain_id=? AND collection_id=? AND view_id=? AND generation=? LIMIT ?)",
                )
                .run(...scope, PAGE_SIZE);
            if (
                removedWork.changes < PAGE_SIZE &&
                removedTrees.changes < PAGE_SIZE
            )
                db.prepare(
                    "UPDATE trait_catalog_generations SET cleanup_pending=0 WHERE generation=?",
                ).run(old.generation);
            return true;
        })();
    }
}
