import type { SyncFollowUp } from "../domain/sync-follow-ups.js";
import type { SyncRangeResult } from "./storage.js";
import type { SyncWorkCompletion } from "../domain/sync-work.js";

export type SyncRangeCommit = {
    result: SyncRangeResult;
    followUps: readonly SyncFollowUp[];
    completion: SyncWorkCompletion;
};

export interface SyncRangeCommitPort {
    // Commit validated facts, coverage, balances, all publication intent and
    // named work progress in one transaction. Failure cannot advance any part.
    commitSyncRange(input: SyncRangeCommit): void;
}
