import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import type { BiddingJobSource } from "../../application/use-cases/bidding/bidding-job-source.js";
import type {
    BidderJob,
    TraitSelector,
    TraitTarget,
} from "../../domain/market/strategy/job.js";

type BiddingJobRow = {
    job_id: string;
    collection_slug: string;
    collection_opensea_slug: string | null;
    collection_address: string;
    target_kind:
        | keyof typeof TRADING_JOB_TARGET_KIND
        | (typeof TRADING_JOB_TARGET_KIND)[keyof typeof TRADING_JOB_TARGET_KIND];
    token_id: string | null;
    floor_wei: string;
    ceiling_wei: string;
    delta_wei: string;
    quantity: number | null;
    target_traits_json: string | null;
    competitor_traits_json: string | null;
};

export class SqliteBiddingJobSource implements BiddingJobSource {
    private readonly selectEnabledJobs: BetterSqlite3NamedStatement<{
        botKind: typeof TRADING_BOT_KIND.Bidding;
        chainId: number;
        status: typeof TRADING_JOB_STATUS.Enabled;
    }>;

    constructor(private readonly chainId: number) {
        this.selectEnabledJobs = db.prepare<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            status: typeof TRADING_JOB_STATUS.Enabled;
        }>(
            "SELECT j.job_id, c.slug AS collection_slug, c.opensea_slug AS collection_opensea_slug, c.address AS collection_address, " +
                "j.target_kind, j.token_id, s.floor_wei, s.ceiling_wei, s.delta_wei, s.quantity, s.target_traits_json, s.competitor_traits_json " +
                "FROM trading_jobs j " +
                "JOIN trading_bidding_job_specs s ON s.job_id = j.job_id " +
                "JOIN collections c ON c.collection_id = j.collection_id " +
                "WHERE j.bot_kind = @botKind AND j.chain_id = @chainId AND j.status = @status " +
                "ORDER BY j.job_id ASC",
        ) as BetterSqlite3NamedStatement<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            status: typeof TRADING_JOB_STATUS.Enabled;
        }>;
    }

    async loadEnabledJobs(): Promise<BidderJob[]> {
        // Read the authoritative enabled bidding job set from the ArtGod SQLite store.
        const rows = this.selectEnabledJobs.all({
            botKind: TRADING_BOT_KIND.Bidding,
            chainId: this.chainId,
            status: TRADING_JOB_STATUS.Enabled,
        }) as BiddingJobRow[];

        // Map persisted job declarations into the stable bidder domain shape without hydrating runtime state yet.
        return rows.map((row) => this.mapJobRow(row));
    }

    private mapJobRow(row: BiddingJobRow): BidderJob {
        const floor = this.parseWei(row.floor_wei, "floor_wei", row.job_id);
        const ceiling = this.parseWei(row.ceiling_wei, "ceiling_wei", row.job_id);
        const delta = this.parseWei(row.delta_wei, "delta_wei", row.job_id);
        if (floor < 0n || ceiling < 0n) {
            throw new Error(
                `Invalid persisted bidding config: floor and ceiling must be >= 0 for jobId=${row.job_id}`,
            );
        }
        if (delta <= 0n) {
            throw new Error(
                `Invalid persisted bidding config: delta must be > 0 for jobId=${row.job_id}`,
            );
        }
        if (floor > ceiling) {
            throw new Error(
                `Invalid persisted bidding config: floor must be <= ceiling for jobId=${row.job_id}`,
            );
        }

        return {
            id: this.parseNonEmptyString(row.job_id, "job_id"),
            network: "eth",
            collectionAddress: this.parseAddress(
                row.collection_address,
                `collection_address for jobId=${row.job_id}`,
            ),
            collectionSlug:
                this.parseCollectionSlug(row.collection_opensea_slug) ??
                this.parseNonEmptyString(
                    row.collection_slug,
                    `collection_slug for jobId=${row.job_id}`,
                ),
            target: this.mapTarget(row),
            config: {
                floor,
                ceiling,
                delta,
            },
            // Keep runtime state empty until runtime-state persistence is wired deliberately.
            state: {},
        };
    }

    private mapTarget(row: BiddingJobRow): BidderJob["target"] {
        if (row.target_kind === TRADING_JOB_TARGET_KIND.Token) {
            return {
                type: "token",
                tokenId: this.parseNonEmptyString(
                    row.token_id,
                    `token_id for jobId=${row.job_id}`,
                ),
            };
        }

        if (row.target_kind === TRADING_JOB_TARGET_KIND.Collection) {
            const traits = this.parseTraitTargets(
                row.target_traits_json,
                `target_traits_json for jobId=${row.job_id}`,
            );
            return {
                type: "collection",
                quantity: this.parseQuantity(row.quantity, row.job_id),
                ...(traits.length > 0 ? { traits } : {}),
            };
        }

        if (row.target_kind === TRADING_JOB_TARGET_KIND.CompetitiveTrait) {
            const targetTraits = this.parseTraitTargets(
                row.target_traits_json,
                `target_traits_json for jobId=${row.job_id}`,
            );
            if (targetTraits.length !== 1) {
                throw new Error(
                    `Invalid competitive-trait bidding job: expected exactly one target trait for jobId=${row.job_id}`,
                );
            }

            return {
                type: "competitiveTrait",
                quantity: this.parseQuantity(row.quantity, row.job_id),
                targetTrait: targetTraits[0],
                competitorTraits: this.parseTraitSelectors(
                    row.competitor_traits_json,
                    `competitor_traits_json for jobId=${row.job_id}`,
                ),
            };
        }

        throw new Error(
            `Unsupported persisted bidding job target_kind=${String(row.target_kind)} for jobId=${row.job_id}`,
        );
    }

    private parseCollectionSlug(value: string | null): string | null {
        if (value === null) {
            return null;
        }

        const normalized = value.trim();
        return normalized === "" ? null : normalized;
    }

    private parseAddress(value: string | null, name: string): string {
        const normalized = this.parseNonEmptyString(value, name).toLowerCase();
        if (!/^0x[a-f0-9]{40}$/.test(normalized)) {
            throw new Error(`Invalid ${name}: ${value}`);
        }
        return normalized;
    }

    private parseNonEmptyString(value: string | null, name: string): string {
        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(`Invalid ${name}: expected a non-empty string`);
        }
        return value.trim();
    }

    private parseWei(value: string, field: string, jobId: string): bigint {
        try {
            return BigInt(value);
        } catch {
            throw new Error(
                `Invalid persisted bidding ${field}: expected wei string for jobId=${jobId}`,
            );
        }
    }

    private parseQuantity(value: number | null, jobId: string): number {
        if (value === null || !Number.isInteger(value) || value <= 0) {
            throw new Error(
                `Invalid persisted bidding quantity: expected integer > 0 for jobId=${jobId}`,
            );
        }
        return value;
    }

    private parseTraitTargets(value: string | null, name: string): TraitTarget[] {
        return this.parseTraitRecords(value, name).map((trait) => ({
            type: trait.type,
            value: trait.value,
        }));
    }

    private parseTraitSelectors(
        value: string | null,
        name: string,
    ): TraitSelector[] {
        return this.parseTraitRecords(value, name).map((trait) => ({
            type: trait.type,
            value: trait.value,
        }));
    }

    private parseTraitRecords(
        value: string | null,
        name: string,
    ): Array<{ type: string; value: string }> {
        if (!value) {
            return [];
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(value);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid ${name}: ${message}`);
        }

        if (!Array.isArray(parsed)) {
            throw new Error(`Invalid ${name}: expected an array`);
        }

        return parsed.map((entry, index) => {
            if (!entry || typeof entry !== "object") {
                throw new Error(`Invalid ${name}[${index}]: expected an object`);
            }

            const record = entry as { type?: unknown; value?: unknown };
            if (
                typeof record.type !== "string" ||
                record.type.trim() === "" ||
                typeof record.value !== "string" ||
                record.value.trim() === ""
            ) {
                throw new Error(
                    `Invalid ${name}[${index}]: expected non-empty type and value`,
                );
            }

            return {
                type: record.type.trim(),
                value: record.value.trim(),
            };
        });
    }
}
