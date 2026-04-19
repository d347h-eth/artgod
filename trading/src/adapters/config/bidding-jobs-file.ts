import { readFile } from "node:fs/promises";
import { parseUnits } from "viem";
import {
    BidderJob,
    TraitSelector,
    TraitTarget,
} from "../../domain/market/strategy/job.js";

type BiddingJobFileRecord = {
    id?: unknown;
    network?: unknown;
    collectionAddress?: unknown;
    collectionSlug?: unknown;
    target?: unknown;
    config?: unknown;
};

type TokenTargetRecord = {
    type: "token";
    tokenId?: unknown;
};

type CollectionTargetRecord = {
    type: "collection";
    quantity?: unknown;
    traits?: unknown;
};

type CompetitiveTraitTargetRecord = {
    type: "competitiveTrait";
    quantity?: unknown;
    targetTrait?: unknown;
    competitorTraits?: unknown;
};

type ConfigRecord = {
    floorEth?: unknown;
    ceilingEth?: unknown;
    deltaEth?: unknown;
};

// Loads operator-managed bidding jobs from a JSON file and normalizes them into BidderJob values.
export async function loadBiddingJobsFromFile(
    filePath: string,
): Promise<BidderJob[]> {
    const raw = await readFile(filePath, "utf8");

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid bidding jobs JSON in ${filePath}: ${message}`);
    }

    if (!Array.isArray(parsed)) {
        throw new Error(`Invalid bidding jobs JSON in ${filePath}: expected an array`);
    }

    const seenIds = new Set<string>();
    return parsed.map((entry, index) => {
        const record = entry as BiddingJobFileRecord;
        const job = normalizeBiddingJobRecord(record, index, filePath);
        if (seenIds.has(job.id)) {
            throw new Error(`Duplicate bidding job id: ${job.id}`);
        }
        seenIds.add(job.id);
        return job;
    });
}

function normalizeBiddingJobRecord(
    record: BiddingJobFileRecord,
    index: number,
    filePath: string,
): BidderJob {
    const context = `bidding job #${index + 1} in ${filePath}`;

    return {
        id: parseNonEmptyString(record.id, `${context}.id`),
        network: parseNetwork(record.network, `${context}.network`),
        collectionAddress: parseAddress(
            record.collectionAddress,
            `${context}.collectionAddress`,
        ),
        collectionSlug: parseNonEmptyString(
            record.collectionSlug,
            `${context}.collectionSlug`,
        ),
        target: normalizeTarget(record.target, `${context}.target`),
        config: normalizeConfig(record.config, `${context}.config`),
        state: {},
    };
}

function normalizeTarget(
    value: unknown,
    name: string,
): BidderJob["target"] {
    if (!value || typeof value !== "object") {
        throw new Error(`Invalid ${name}: expected an object`);
    }

    const type = (value as { type?: unknown }).type;
    if (type === "token") {
        const target = value as TokenTargetRecord;
        return {
            type: "token",
            tokenId: parseNonEmptyString(target.tokenId, `${name}.tokenId`),
        };
    }

    if (type === "collection") {
        const target = value as CollectionTargetRecord;
        const traits = normalizeOptionalTraitTargets(
            target.traits,
            `${name}.traits`,
        );
        return {
            type: "collection",
            quantity: parsePositiveInteger(target.quantity, `${name}.quantity`),
            ...(traits ? { traits } : {}),
        };
    }

    if (type === "competitiveTrait") {
        const target = value as CompetitiveTraitTargetRecord;
        return {
            type: "competitiveTrait",
            quantity: parsePositiveInteger(target.quantity, `${name}.quantity`),
            targetTrait: normalizeTraitTarget(
                target.targetTrait,
                `${name}.targetTrait`,
            ),
            competitorTraits: normalizeTraitSelectors(
                target.competitorTraits,
                `${name}.competitorTraits`,
            ),
        };
    }

    throw new Error(`Invalid ${name}.type: ${String(type)}`);
}

function normalizeConfig(value: unknown, name: string): BidderJob["config"] {
    if (!value || typeof value !== "object") {
        throw new Error(`Invalid ${name}: expected an object`);
    }

    const record = value as ConfigRecord;
    return {
        floor: parseEthAmount(record.floorEth, `${name}.floorEth`),
        ceiling: parseEthAmount(record.ceilingEth, `${name}.ceilingEth`),
        delta: parseEthAmount(record.deltaEth, `${name}.deltaEth`),
    };
}

function normalizeOptionalTraitTargets(
    value: unknown,
    name: string,
): TraitTarget[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    const targets = normalizeTraitTargets(value, name);
    return targets.length > 0 ? targets : undefined;
}

function normalizeTraitTargets(value: unknown, name: string): TraitTarget[] {
    if (!Array.isArray(value)) {
        throw new Error(`Invalid ${name}: expected an array`);
    }

    return value.map((entry, index) =>
        normalizeTraitTarget(entry, `${name}[${index}]`),
    );
}

function normalizeTraitTarget(value: unknown, name: string): TraitTarget {
    if (!value || typeof value !== "object") {
        throw new Error(`Invalid ${name}: expected an object`);
    }

    const record = value as { type?: unknown; value?: unknown };
    return {
        type: parseNonEmptyString(record.type, `${name}.type`),
        value: parseNonEmptyString(record.value, `${name}.value`),
    };
}

function normalizeTraitSelectors(
    value: unknown,
    name: string,
): TraitSelector[] {
    if (!Array.isArray(value)) {
        throw new Error(`Invalid ${name}: expected an array`);
    }

    return value.map((entry, index) => {
        if (!entry || typeof entry !== "object") {
            throw new Error(`Invalid ${name}[${index}]: expected an object`);
        }

        const record = entry as { type?: unknown; value?: unknown };
        return {
            type: parseNonEmptyString(record.type, `${name}[${index}].type`),
            ...(record.value === undefined
                ? {}
                : {
                      value: parseNonEmptyString(
                          record.value,
                          `${name}[${index}].value`,
                      ),
                  }),
        };
    });
}

function parseNetwork(value: unknown, name: string): "eth" {
    if (value !== "eth") {
        throw new Error(`Invalid ${name}: only "eth" is supported`);
    }
    return "eth";
}

function parseAddress(value: unknown, name: string): string {
    const normalized = parseNonEmptyString(value, name);
    if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
        throw new Error(`Invalid ${name}: ${String(value)}`);
    }
    return normalized.toLowerCase();
}

function parseEthAmount(value: unknown, name: string): bigint {
    const normalized = parseNonEmptyString(value, name);
    try {
        return parseUnits(normalized, 18);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid ${name}: ${message}`);
    }
}

function parsePositiveInteger(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        throw new Error(`Invalid ${name}: expected an integer > 0`);
    }
    return value;
}

function parseNonEmptyString(value: unknown, name: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new Error(`Invalid ${name}: expected a non-empty string`);
    }
    return value.trim();
}
