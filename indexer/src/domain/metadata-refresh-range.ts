import {
    DOMAIN_JOB_KIND,
    type MetadataRefreshRangePayload,
} from "./domain-jobs.js";
import type { JobEnvelope } from "./jobs.js";
import { QUEUE_NAMES } from "./queues.js";

// Every cursor is a child of the same root publication. Distinct canonical roots
// cannot share a tail ID, and every on-chain child passes the root's fork fence.
export function buildMetadataRangeContinuation(input: {
    job: JobEnvelope<MetadataRefreshRangePayload>;
    cursorTokenId: string;
    now: number;
}): JobEnvelope<MetadataRefreshRangePayload> {
    const { job, cursorTokenId } = input;
    const rootJobId = job.payload.rootJobId ?? job.jobId;
    return {
        jobId: `${rootJobId}:cursor:${cursorTokenId}`,
        kind: DOMAIN_JOB_KIND.MetadataRefreshRange,
        queue: QUEUE_NAMES.MetadataRefresh,
        payload: { ...job.payload, rootJobId, cursorTokenId },
        attempt: 0,
        scheduledAt: input.now,
        chainId: job.chainId,
        collectionId: job.payload.collectionId,
        traceId: job.traceId ?? job.jobId,
        ...(job.onchainBlock === undefined
            ? {}
            : { onchainBlock: job.onchainBlock }),
    };
}

export function chunkMetadataTokenRange(input: {
    fromTokenId: string;
    toTokenId: string;
    cursorTokenId: string;
    chunkSize: number;
}): { tokenIds: string[]; nextCursorTokenId: string | null } {
    const { fromTokenId, toTokenId, cursorTokenId, chunkSize } = input;
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)
        throw new Error(`Invalid metadata refresh chunk size: ${chunkSize}`);
    const from = BigInt(fromTokenId),
        to = BigInt(toTokenId),
        cursor = BigInt(cursorTokenId);
    if (from > to)
        throw new Error(
            `Invalid metadata refresh range: fromTokenId (${fromTokenId}) > toTokenId (${toTokenId})`,
        );
    if (cursor < from || cursor > to + 1n)
        throw new Error(
            `Invalid metadata refresh cursor ${cursorTokenId} for range [${fromTokenId}, ${toTokenId}]`,
        );
    if (cursor === to + 1n) return { tokenIds: [], nextCursorTokenId: null };
    const limit = cursor + BigInt(chunkSize) - 1n;
    const chunkEnd = to < limit ? to : limit;
    const tokenIds: string[] = [];
    for (let tokenId = cursor; tokenId <= chunkEnd; tokenId += 1n)
        tokenIds.push(tokenId.toString());
    return {
        tokenIds,
        nextCursorTokenId: chunkEnd >= to ? null : (chunkEnd + 1n).toString(),
    };
}
