import { db } from "@artgod/shared/database";
import type { BetterSqlite3NamedStatement } from "@artgod/shared/database";
import {
    TRADING_BOT_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
    type TradingJobStatus,
} from "@artgod/shared/types";
import type {
    BiddingJobSource,
    BiddingJobSourceRecord,
} from "../../application/use-cases/bidding/bidding-job-source.js";
import {
    BIDDER_TARGET_TYPE,
    type BidderJob,
    type TraitSelector,
    type TraitTarget,
} from "../../domain/market/strategy/job.js";

type BiddingJobRow = {
    job_id: string;
    collection_slug: string;
    collection_opensea_slug: string | null;
    collection_address: string;
    status: TradingJobStatus;
    revision: number;
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
    current_price_wei: string | null;
    runtime_job_revision: number | null;
    active_order_id: string | null;
    active_protocol_address: string | null;
    active_order_placed_at: string | null;
    active_order_verified_at: string | null;
    active_expiration_time_ms: number | null;
    runtime_updated_at: string | null;
};

export class SqliteBiddingJobSource implements BiddingJobSource {
    private readonly selectEnabledJobs: BetterSqlite3NamedStatement<{
        botKind: typeof TRADING_BOT_KIND.Bidding;
        chainId: number;
        status: typeof TRADING_JOB_STATUS.Enabled;
    }>;
    private readonly selectJobById: BetterSqlite3NamedStatement<{
        botKind: typeof TRADING_BOT_KIND.Bidding;
        chainId: number;
        jobId: string;
    }>;

    constructor(private readonly chainId: number) {
        const selectFields =
            "SELECT j.job_id, j.status, j.revision, c.slug AS collection_slug, c.opensea_slug AS collection_opensea_slug, c.address AS collection_address, " +
            "j.target_kind, j.token_id, s.floor_wei, s.ceiling_wei, s.delta_wei, s.quantity, s.target_traits_json, s.competitor_traits_json, " +
            "r.current_price_wei, r.job_revision AS runtime_job_revision, r.active_order_id, r.active_protocol_address, r.active_order_placed_at, r.active_order_verified_at, r.active_expiration_time_ms, r.updated_at AS runtime_updated_at " +
            "FROM trading_jobs j " +
            "JOIN trading_bidding_job_specs s ON s.job_id = j.job_id " +
            "JOIN collections c ON c.collection_id = j.collection_id " +
            "LEFT JOIN trading_bidding_job_runtime_state r ON r.job_id = j.job_id ";

        this.selectEnabledJobs = db.prepare<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            status: typeof TRADING_JOB_STATUS.Enabled;
        }>(
            selectFields +
                "WHERE j.bot_kind = @botKind AND j.chain_id = @chainId AND j.status = @status " +
                "ORDER BY j.job_id ASC",
        ) as BetterSqlite3NamedStatement<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            status: typeof TRADING_JOB_STATUS.Enabled;
        }>;

        this.selectJobById = db.prepare<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            jobId: string;
        }>(
            selectFields +
                "WHERE j.bot_kind = @botKind AND j.chain_id = @chainId AND j.job_id = @jobId " +
                "LIMIT 1",
        ) as BetterSqlite3NamedStatement<{
            botKind: typeof TRADING_BOT_KIND.Bidding;
            chainId: number;
            jobId: string;
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

    async loadJobById(jobId: string): Promise<BiddingJobSourceRecord | null> {
        // Read one declared bidding job by id so command reconciliation can resolve archived or paused jobs too.
        const row = this.selectJobById.get({
            botKind: TRADING_BOT_KIND.Bidding,
            chainId: this.chainId,
            jobId,
        }) as BiddingJobRow | undefined;
        return row ? this.mapJobRecord(row) : null;
    }

    async loadEnabledJobById(jobId: string): Promise<BidderJob | null> {
        const record = await this.loadJobById(jobId);
        return record?.status === TRADING_JOB_STATUS.Enabled ? record.job : null;
    }

    private mapJobRecord(row: BiddingJobRow): BiddingJobSourceRecord {
        return {
            job: this.mapJobRow(row),
            status: row.status,
            revision: row.revision,
        };
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
            revision: row.revision,
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
            state: this.mapRuntimeState(row),
        };
    }

    private mapRuntimeState(row: BiddingJobRow): BidderJob["state"] {
        if (!row.runtime_updated_at || row.runtime_job_revision !== row.revision) {
            return {};
        }

        return {
            activeOrderId:
                row.active_order_id && row.active_order_id.trim() !== ""
                    ? row.active_order_id
                    : undefined,
            activeProtocolAddress:
                row.active_protocol_address &&
                row.active_protocol_address.trim() !== ""
                    ? row.active_protocol_address
                    : undefined,
            activeOrderPlacedAt:
                row.active_order_placed_at &&
                row.active_order_placed_at.trim() !== ""
                    ? row.active_order_placed_at
                    : undefined,
            activeOrderVerifiedAt:
                row.active_order_verified_at &&
                row.active_order_verified_at.trim() !== ""
                    ? row.active_order_verified_at
                    : undefined,
            currentPrice: this.parseOptionalWei(
                row.current_price_wei,
                "current_price_wei",
                row.job_id,
            ),
            activeExpirationTimeMs:
                typeof row.active_expiration_time_ms === "number"
                    ? row.active_expiration_time_ms
                    : undefined,
        };
    }

    private mapTarget(row: BiddingJobRow): BidderJob["target"] {
        if (row.target_kind === TRADING_JOB_TARGET_KIND.Token) {
            return {
                type: BIDDER_TARGET_TYPE.Token,
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
                type: BIDDER_TARGET_TYPE.Collection,
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
                type: BIDDER_TARGET_TYPE.CompetitiveTrait,
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

    private parseOptionalWei(
        value: string | null,
        field: string,
        jobId: string,
    ): bigint | undefined {
        if (value === null) {
            return undefined;
        }
        return this.parseWei(value, field, jobId);
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
