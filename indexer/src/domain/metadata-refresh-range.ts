import {
    DOMAIN_JOB_KIND,
    type MetadataRefreshRangePayload,
} from "./domain-jobs.js";
import type { JobEnvelope } from "./jobs.js";
import { QUEUE_NAMES } from "./queues.js";
import { normalizeEvmTokenId } from "@artgod/shared/evm/token-id";

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
        ...(job.workClass === undefined ? {} : { workClass: job.workClass }),
        ...(job.onchainBlock === undefined
            ? {}
            : { onchainBlock: job.onchainBlock }),
    };
}

/** The persisted cursor remains an inclusive numeric lower bound, including legacy jobs. */
export function metadataTokenRangeSelection(input: {
    fromTokenId: string;
    toTokenId: string;
    cursorTokenId: string;
    chunkSize: number;
}): { fromTokenId: string; toTokenId: string; limit: number } | null {
    const { fromTokenId, toTokenId, cursorTokenId, chunkSize } = input;
    if (
        !Number.isSafeInteger(chunkSize) ||
        chunkSize <= 0 ||
        !Number.isSafeInteger(chunkSize + 1)
    )
        throw new Error(`Invalid metadata refresh chunk size: ${chunkSize}`);
    const normalizedFrom = normalizeEvmTokenId(fromTokenId);
    const normalizedTo = normalizeEvmTokenId(toTokenId);
    if (normalizedFrom === null || normalizedTo === null)
        throw new Error("Invalid metadata refresh token bounds");
    const from = BigInt(normalizedFrom),
        to = BigInt(normalizedTo);
    // The exhausted sentinel is one beyond the upper bound, even at uint256 max.
    const normalizedCursor =
        cursorTokenId === (to + 1n).toString()
            ? cursorTokenId
            : normalizeEvmTokenId(cursorTokenId);
    if (normalizedCursor === null)
        throw new Error("Invalid metadata refresh cursor");
    const cursor = BigInt(normalizedCursor);
    if (from > to)
        throw new Error(
            `Invalid metadata refresh range: fromTokenId (${fromTokenId}) > toTokenId (${toTokenId})`,
        );
    if (cursor < from || cursor > to + 1n)
        throw new Error(
            `Invalid metadata refresh cursor ${cursorTokenId} for range [${fromTokenId}, ${toTokenId}]`,
        );
    if (cursor === to + 1n) return null;
    return {
        fromTokenId: cursor.toString(),
        toTokenId: to.toString(),
        limit: chunkSize + 1,
    };
}

/** Overfetch one known ID to decide continuation without exploring empty numeric space. */
export function chunkMetadataTokenRange(input: {
    tokenIds: readonly string[];
    chunkSize: number;
}): { tokenIds: string[]; nextCursorTokenId: string | null } {
    const tokenIds = input.tokenIds.slice(0, input.chunkSize);
    return {
        tokenIds,
        nextCursorTokenId:
            input.tokenIds.length > input.chunkSize
                ? (BigInt(tokenIds.at(-1)!) + 1n).toString()
                : null,
    };
}
