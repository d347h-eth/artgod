import type { JobEnvelope } from "./jobs.js";

export const DEAD_LETTER_KIND = "dead-letter" as const;

export type DeadLetterPayload = {
    original: JobEnvelope<unknown>;
    error: string;
    failedAt: number;
};
