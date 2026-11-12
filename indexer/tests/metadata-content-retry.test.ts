import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
    decideMetadataContentRetry,
    METADATA_PENDING_REASON,
    type MetadataContentRetryPolicy,
} from "../src/domain/metadata-pending.js";

const POLICY: MetadataContentRetryPolicy = { attemptAgesMs: [0, 10, 100] };

describe("absolute incomplete-content retry decisions", () => {
    it("anchors the first response and advances to the next unmissed age", () => {
        expect(decideMetadataContentRetry(null, 1_000, POLICY)).toEqual({
            pendingSince: 1_000,
            nextAttemptAt: 1_010,
        });
        expect(decideMetadataContentRetry(1_000, 1_010, POLICY)).toEqual({
            pendingSince: 1_000,
            nextAttemptAt: 1_100,
        });
        expect(
            decideMetadataContentRetry(1_000, 1_099, POLICY).nextAttemptAt,
        ).toBe(1_100);
    });

    it.each([1_100, 50_000])(
        "exhausts only an assessment at or after the final age (%s)",
        (now) => {
            expect(decideMetadataContentRetry(1_000, now, POLICY)).toEqual({
                pendingSince: 1_000,
                nextAttemptAt: null,
            });
        },
    );
});

describe("metadata content retry migration", () => {
    it("preserves pre-existing pending obligations without retroactively starting or exhausting their content window", () => {
        const database = new Database(":memory:");
        const migrate = (name: string) =>
            database.exec(
                readFileSync(
                    new URL(
                        `../../database/migrations/${name}.sql`,
                        import.meta.url,
                    ),
                    "utf8",
                ),
            );
        try {
            database.pragma("foreign_keys = ON");
            database.exec(
                "CREATE TABLE collections(collection_id INTEGER PRIMARY KEY); INSERT INTO collections VALUES(1)",
            );
            migrate("074_metadata_pending");
            migrate("075_metadata_pending_failures");
            database
                .prepare(
                    "INSERT INTO metadata_pending(chain_id,collection_id,token_id,options_json,attempts,failures,first_pending_at,last_attempt_at,due_at,reason) VALUES(1,1,'1','{}',17,16,100,200,300,?)",
                )
                .run(METADATA_PENDING_REASON.NotReady);
            const before = database
                .prepare("SELECT * FROM metadata_pending")
                .get() as Record<string, unknown>;
            migrate("076_metadata_content_retry_exhaustion");
            expect(
                database.prepare("SELECT * FROM metadata_pending").get(),
            ).toEqual({
                ...before,
                content_pending_at: null,
                exhausted_at: null,
            });
        } finally {
            database.close();
        }
    });
});
