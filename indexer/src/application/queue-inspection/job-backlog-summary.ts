export type InspectableJobEnvelope = {
    seq: number;
    time: string;
    subject: string;
    jobId: string;
    kind: string;
    queue: string;
    attempt: number;
    scheduledAt: number;
    chainId: number;
    collectionId: number | null;
    traceId: string | null;
    payload: Record<string, unknown>;
};

export type CountBucket = {
    key: string | number | null;
    count: number;
};

export type ReasonSummary = {
    reason: string | number | null;
    count: number;
    scopeCounts: CountBucket[];
    uniqueMakers: number;
    uniqueBlocks: number;
    minBlock: number | null;
    maxBlock: number | null;
    topMakers: CountBucket[];
    topBlocks: CountBucket[];
    sample: InspectableJobEnvelope | null;
};

export type JobBacklogSummary = {
    total: number;
    seq: { first: number | null; last: number | null };
    messageTime: { first: string | null; last: string | null };
    scheduledAt: { first: number | null; last: number | null };
    envelopeKinds: CountBucket[];
    envelopeQueues: CountBucket[];
    chainIds: CountBucket[];
    attempts: CountBucket[];
    scopes: CountBucket[];
    reasons: CountBucket[];
    scopeReasons: CountBucket[];
    collectionIds: CountBucket[];
    blockStats: {
        min: number | null;
        max: number | null;
        unique: number;
        top: CountBucket[];
    };
    makerStats: {
        unique: number;
        top: CountBucket[];
    };
    txStats: {
        uniqueIncludingNull: number;
        top: CountBucket[];
    };
    logIndexTop: CountBucket[];
    byReason: ReasonSummary[];
    samples: {
        first: InspectableJobEnvelope[];
        last: InspectableJobEnvelope[];
    };
};

export type JobBacklogSummaryOptions = {
    topN?: number;
    sampleSize?: number;
};

const DEFAULT_TOP_N = 20;
const DEFAULT_SAMPLE_SIZE = 3;

// Summarize decoded queue messages without depending on a concrete queue type.
export function summarizeJobBacklog(
    rows: InspectableJobEnvelope[],
    options: JobBacklogSummaryOptions = {},
): JobBacklogSummary {
    const topN = options.topN ?? DEFAULT_TOP_N;
    const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
    const blockNumbers = numericValues(rows, (row) => row.payload.blockNumber);
    const makers = rows.map((row) => nullableBucketKey(row.payload.maker));
    const txHashes = rows.map((row) => nullableBucketKey(row.payload.txHash));

    return {
        total: rows.length,
        seq: {
            first: rows[0]?.seq ?? null,
            last: rows.at(-1)?.seq ?? null,
        },
        messageTime: {
            first: rows[0]?.time ?? null,
            last: rows.at(-1)?.time ?? null,
        },
        scheduledAt: {
            first: rows[0]?.scheduledAt ?? null,
            last: rows.at(-1)?.scheduledAt ?? null,
        },
        envelopeKinds: countBy(rows, (row) => row.kind),
        envelopeQueues: countBy(rows, (row) => row.queue),
        chainIds: countBy(rows, (row) => row.chainId),
        attempts: countBy(rows, (row) => row.attempt),
        scopes: countBy(rows, (row) => nullableBucketKey(row.payload.scope)),
        reasons: countBy(rows, (row) => nullableBucketKey(row.payload.reason)),
        scopeReasons: countBy(
            rows,
            (row) =>
                `${nullableBucketKey(row.payload.scope) ?? "null"}:${
                    nullableBucketKey(row.payload.reason) ?? "null"
                }`,
        ),
        collectionIds: countBy(rows, (row) => row.collectionId),
        blockStats: {
            min: minNumber(blockNumbers),
            max: maxNumber(blockNumbers),
            unique: uniqueCount(blockNumbers),
            top: countBy(rows, (row) =>
                nullableBucketKey(row.payload.blockNumber),
            ).slice(0, topN),
        },
        makerStats: {
            unique: uniqueCount(makers),
            top: countBy(rows, (row) =>
                nullableBucketKey(row.payload.maker),
            ).slice(0, topN),
        },
        txStats: {
            uniqueIncludingNull: uniqueCount(txHashes),
            top: countBy(rows, (row) =>
                nullableBucketKey(row.payload.txHash),
            ).slice(0, topN),
        },
        logIndexTop: countBy(rows, (row) =>
            nullableBucketKey(row.payload.logIndex),
        ).slice(0, topN),
        byReason: summarizeByReason(rows, topN),
        samples: {
            first: rows.slice(0, sampleSize),
            last: sampleSize <= 0 ? [] : rows.slice(-sampleSize),
        },
    };
}

function summarizeByReason(
    rows: InspectableJobEnvelope[],
    topN: number,
): ReasonSummary[] {
    const byReason = groupBy(rows, (row) =>
        nullableBucketKey(row.payload.reason),
    );

    return Array.from(byReason.entries())
        .map(([reason, reasonRows]) => {
            const blockNumbers = numericValues(
                reasonRows,
                (row) => row.payload.blockNumber,
            );
            return {
                reason,
                count: reasonRows.length,
                scopeCounts: countBy(reasonRows, (row) =>
                    nullableBucketKey(row.payload.scope),
                ),
                uniqueMakers: uniqueCount(
                    reasonRows.map((row) =>
                        nullableBucketKey(row.payload.maker),
                    ),
                ),
                uniqueBlocks: uniqueCount(blockNumbers),
                minBlock: minNumber(blockNumbers),
                maxBlock: maxNumber(blockNumbers),
                topMakers: countBy(reasonRows, (row) =>
                    nullableBucketKey(row.payload.maker),
                ).slice(0, topN),
                topBlocks: countBy(reasonRows, (row) =>
                    nullableBucketKey(row.payload.blockNumber),
                ).slice(0, topN),
                sample: reasonRows[0] ?? null,
            };
        })
        .sort(compareReasonSummaries);
}

function countBy<T>(
    values: T[],
    resolve: (value: T) => string | number | null,
): CountBucket[] {
    const counts = new Map<string, CountBucket>();
    for (const value of values) {
        const key = resolve(value);
        const mapKey = JSON.stringify(key);
        const existing = counts.get(mapKey);
        if (existing) {
            existing.count += 1;
            continue;
        }
        counts.set(mapKey, { key, count: 1 });
    }
    return Array.from(counts.values()).sort(compareCountBuckets);
}

function groupBy<T>(
    values: T[],
    resolve: (value: T) => string | number | null,
): Map<string | number | null, T[]> {
    const groups = new Map<
        string,
        { key: string | number | null; rows: T[] }
    >();
    for (const value of values) {
        const key = resolve(value);
        const mapKey = JSON.stringify(key);
        const existing = groups.get(mapKey);
        if (existing) {
            existing.rows.push(value);
            continue;
        }
        groups.set(mapKey, { key, rows: [value] });
    }
    return new Map(
        Array.from(groups.values()).map((group) => [group.key, group.rows]),
    );
}

function nullableBucketKey(value: unknown): string | number | null {
    if (typeof value === "string" || typeof value === "number") {
        return value;
    }
    return null;
}

function numericValues<T>(
    values: T[],
    resolve: (value: T) => unknown,
): number[] {
    return values
        .map(resolve)
        .filter((value): value is number => Number.isFinite(value));
}

function uniqueCount(values: Array<string | number | null>): number {
    return new Set(values.map((value) => JSON.stringify(value))).size;
}

function minNumber(values: number[]): number | null {
    if (values.length === 0) return null;
    return Math.min(...values);
}

function maxNumber(values: number[]): number | null {
    if (values.length === 0) return null;
    return Math.max(...values);
}

function compareCountBuckets(left: CountBucket, right: CountBucket): number {
    if (left.count !== right.count) {
        return right.count - left.count;
    }
    return String(left.key).localeCompare(String(right.key));
}

function compareReasonSummaries(
    left: ReasonSummary,
    right: ReasonSummary,
): number {
    if (left.count !== right.count) {
        return right.count - left.count;
    }
    return String(left.reason).localeCompare(String(right.reason));
}
