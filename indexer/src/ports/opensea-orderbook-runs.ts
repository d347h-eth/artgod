import type { OpenSeaOrderbookRunKind } from "../domain/opensea-jobs.js";

export type OpenSeaOrderbookRunInput = {
    chainId: number;
    collectionId: number;
    kind: OpenSeaOrderbookRunKind;
};

export interface OpenSeaOrderbookRunsPort {
    startRun(input: OpenSeaOrderbookRunInput): number;
    completeRun(runId: number): boolean;
    failRun(runId: number, errorMessage: string): boolean;
}
