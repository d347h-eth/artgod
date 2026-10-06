import type { SyncFollowUp } from "../domain/sync-follow-ups.js";
import type { SyncRangeResult } from "./storage.js";

export type SyncRangeCommit = {
    result: SyncRangeResult;
    followUps: readonly SyncFollowUp[];
};

export interface SyncRangeCommitPort {
    // Commit validated facts, coverage, balances and all publication intent in
    // one transaction. Nothing may advance if retaining any follow-up fails.
    commitSyncRange(input: SyncRangeCommit): void;
}
