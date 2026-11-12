import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { runWorker } from "../src/application/worker-runner.js";
import { metadataTokenRangeSelection } from "../src/domain/metadata-refresh-range.js";
import { EVM_TOKEN_ID_MAX } from "@artgod/shared/evm/token-id";
import { TOKEN_RECORD_KIND } from "@artgod/shared/types/token-records";
import { SqliteMetadataRangeTokens } from "../src/infra/metadata/sqlite-metadata-range-tokens.js";
import type { MetadataRefreshRangePayload } from "../src/domain/domain-jobs.js";
import type { JobEnvelope } from "../src/domain/jobs.js";
import { QUEUE_NAMES } from "../src/domain/queues.js";
import type { QueueMessage, QueuePort } from "../src/ports/queue.js";
import { metadataRangeFixture } from "./helpers/metadata-range-fixture.js";
import { createTempDbPath } from "./helpers/test-helpers.js";
import { loadTestEnv } from "./helpers/test-env.js";

describe("metadata range continuation context", () => {
    loadTestEnv();
    beforeEach(async () => {
        setDbPath(await createTempDbPath());
        await createMigrationRunner().runMigrations();
    });

    function fixture(
        options: Omit<Parameters<typeof metadataRangeFixture>[0], "queue"> = {},
    ) {
        const published: JobEnvelope<MetadataRefreshRangePayload>[] = [];
        const queue: Pick<QueuePort, "publish"> = {
            publish: async (_queue, job) => {
                published.push(job as JobEnvelope<MetadataRefreshRangePayload>);
            },
        };
        return { ...metadataRangeFixture({ queue, ...options }), published };
    }

    it("keeps one revision-qualified root, origin and collection through three chunks and duplicate publication", async () => {
        const f = fixture();
        await f.handler(f.root);
        const first = f.published[0];
        await f.handler(first);
        const second = f.published[1];
        await f.handler(second);
        expect(f.published).toHaveLength(2);
        expect(f.uriReads.map((read) => read.tokenId)).toEqual([
            "1",
            "2",
            "3",
            "4",
            "5",
            "6",
        ]);
        for (const [job, cursor] of [
            [first, "3"],
            [second, "5"],
        ] as const) {
            expect(job.jobId).toBe(`${f.root.jobId}:cursor:${cursor}`);
            expect(job.payload.rootJobId).toBe(f.root.jobId);
            expect(job.onchainBlock).toEqual(f.root.onchainBlock);
            expect(job.collectionId).toBe(f.collectionId);
        }
        await f.handler(f.root);
        expect(f.published[2].jobId).toBe(first.jobId);
    });

    it("ACKs an orphan continuation without admitting another metadata read", async () => {
        const f = fixture();
        await f.handler(f.root);
        const tail = f.published[0];
        f.rollback();
        let consume!: (
            message: QueueMessage<MetadataRefreshRangePayload>,
        ) => Promise<void>;
        const queue = {
            subscribe: async (_queue: unknown, callback: typeof consume) => {
                consume = callback;
                return async () => {};
            },
        } as unknown as QueuePort;
        const stop = await runWorker(
            queue,
            {
                queue: QUEUE_NAMES.MetadataRefresh,
                consumerName: "metadata-range-unit",
            },
            f.handler,
            { admission: f.admission },
        );
        const ack = vi.fn(async () => {}),
            nack = vi.fn(async () => {});
        await consume({ data: tail, ack, nack, touch: async () => {} });
        await stop();
        expect(ack).toHaveBeenCalledTimes(1);
        expect(nack).not.toHaveBeenCalled();
        expect(f.uriReads.map((read) => read.tokenId)).toEqual(["1", "2"]);
        expect(f.admission.isCurrent(tail)).toBe(false);
    });

    it("supports ordinary and legacy envelopes without fabricating a fork identity", async () => {
        const f = fixture();
        const ordinary = {
            ...f.root,
            jobId: "ordinary-range",
            collectionId: undefined,
            onchainBlock: undefined,
        };
        await f.handler(ordinary);
        const first = f.published[0];
        expect(first.onchainBlock).toBeUndefined();
        expect(first.collectionId).toBe(f.collectionId);
        expect(first.payload.rootJobId).toBe(ordinary.jobId);
        await f.handler(first);
        expect(f.published[1].jobId).toBe(`${ordinary.jobId}:cursor:5`);
        expect(f.admission.isCurrent(first)).toBe(true);
    });

    it("rejects mismatched scope and invalid cursor before remote reads, and accepts an exhausted cursor", async () => {
        const f = fixture();
        await expect(
            f.handler({ ...f.root, collectionId: f.collectionId + 1 }),
        ).rejects.toThrow();
        await expect(
            f.handler({
                ...f.root,
                payload: { ...f.root.payload, cursorTokenId: "0" },
            }),
        ).rejects.toThrow();
        await f.handler({
            ...f.root,
            payload: { ...f.root.payload, cursorTokenId: "7" },
        });
        expect(f.uriReads).toEqual([]);
        expect(f.published).toEqual([]);
        expect(
            metadataTokenRangeSelection({
                fromTokenId: "9007199254740993",
                toTokenId: "9007199254740996",
                cursorTokenId: "9007199254740993",
                chunkSize: 2,
            }),
        ).toEqual({
            fromTokenId: "9007199254740993",
            toTokenId: "9007199254740996",
            limit: 3,
        });
    });

    it("resumes a legacy integer cursor by jumping directly over a sparse unminted gap", async () => {
        const f = fixture({
            tokenIds: ["1", "116667", "1000001"],
            toTokenId: "3000018",
        });
        await f.handler({
            ...f.root,
            payload: { ...f.root.payload, cursorTokenId: "209201" },
        });
        expect(f.uriReads.map((row) => row.tokenId)).toEqual(["1000001"]);
        expect(f.published).toEqual([]);
    });

    it("rejects fractional or unsafe page sizes before selecting inventory", () => {
        for (const chunkSize of [
            0,
            -1,
            0.9999999999999999,
            1.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER,
        ]) {
            expect(() =>
                metadataTokenRangeSelection({
                    fromTokenId: "1",
                    toTokenId: "2",
                    cursorTokenId: "1",
                    chunkSize,
                }),
            ).toThrow("Invalid metadata refresh chunk size");
        }
    });

    it("finishes an empty uint256-wide range without an RPC call or continuation", async () => {
        const f = fixture({
            tokenIds: [],
            toTokenId: EVM_TOKEN_ID_MAX.toString(),
        });
        await f.handler(f.root);
        expect(f.uriReads).toEqual([]);
        expect(f.published).toEqual([]);
        await f.handler({
            ...f.root,
            payload: {
                ...f.root.payload,
                cursorTokenId: (EVM_TOKEN_ID_MAX + 1n).toString(),
            },
        });
        expect(f.published).toEqual([]);
    });

    it("orders sparse IDs numerically beyond safe integers through uint256 max", async () => {
        const ids = [
            "2",
            "10",
            "9007199254740993",
            EVM_TOKEN_ID_MAX.toString(),
        ];
        const f = fixture({
            tokenIds: ids,
            toTokenId: EVM_TOKEN_ID_MAX.toString(),
        });
        await f.handler(f.root);
        expect(f.published).toHaveLength(1);
        expect(f.published[0].payload.cursorTokenId).toBe("11");
        await f.handler(f.published[0]);
        expect(f.uriReads.map((row) => row.tokenId)).toEqual(ids);
        expect(f.published).toHaveLength(1);
    });

    it("includes balance-only tokens awaiting metadata, deduplicates holders/catalog rows, and excludes synthetic rows", async () => {
        const f = fixture({ tokenIds: ["1", "10"], toTokenId: "20" });
        const contract = f.registry.getCollection(1, f.collectionId)!.address;
        const balance = db.prepare(
            "INSERT INTO nft_balances(chain_id,collection_id,contract_address,token_id,owner,amount,last_block_number,last_block_hash,last_block_timestamp,last_tx_hash,last_log_index) VALUES(1,?,?,?,?,'1',102,'hash',1,'tx',0)",
        );
        for (const tokenId of ["1", "9"])
            for (const owner of [
                "0x" + "22".repeat(20),
                "0x" + "33".repeat(20),
            ])
                balance.run(f.collectionId, contract, tokenId, owner);
        db.prepare(
            "INSERT INTO tokens(chain_id,collection_id,contract_address,token_id,record_kind,record_source_key) VALUES(1,?,?,'3',?,'fixture')",
        ).run(f.collectionId, contract, TOKEN_RECORD_KIND.ExtensionSynthetic);
        await f.handler(f.root);
        await f.handler(f.published[0]);
        expect(f.uriReads.map((row) => row.tokenId)).toEqual(["1", "9", "10"]);
        expect(f.metadataRows().map((row) => row.token_id)).toEqual([
            "1",
            "9",
            "10",
        ]);
    });

    it("uses both numeric seek indexes without sorting or materializing the inventory per page", () => {
        const f = fixture();
        const prepare = vi.spyOn(db, "prepare");
        new SqliteMetadataRangeTokens();
        const sql = prepare.mock.calls[0][0];
        prepare.mockRestore();
        const plan = db.prepare("EXPLAIN QUERY PLAN " + sql).all({
            chainId: 1,
            collectionId: f.collectionId,
            fromTokenId: "1",
            toTokenId: "3000018",
            fromLength: 1,
            toLength: 7,
            recordKind: TOKEN_RECORD_KIND.Canonical,
            limit: 3,
        }) as { detail: string }[];
        expect(
            plan.some((row) =>
                row.detail.includes("tokens_collection_numeric_sort_idx"),
            ),
        ).toBe(true);
        expect(
            plan.some((row) =>
                row.detail.includes(
                    "nft_balances_collection_numeric_token_idx",
                ),
            ),
        ).toBe(true);
        expect(plan.some((row) => row.detail.includes("TEMP B-TREE"))).toBe(
            false,
        );
    });

    it("limits selection to the requested collection, chain and inclusive token bounds", async () => {
        const f = fixture({ tokenIds: ["0", "2", "9"], toTokenId: "3" });
        const contract = f.registry.getCollection(1, f.collectionId)!.address;
        const other = db
            .prepare(
                "INSERT INTO collections(chain_id,slug,address,standard,status,token_scope_kind) VALUES(1,'other',?,'erc721','live','contract_all_tokens')",
            )
            .run("0x" + "44".repeat(20)).lastInsertRowid;
        const insert = db.prepare(
            "INSERT INTO tokens(chain_id,collection_id,contract_address,token_id,record_kind) VALUES(?,?,?,?,?)",
        );
        insert.run(1, other, contract, "1", TOKEN_RECORD_KIND.Canonical);
        insert.run(
            2,
            f.collectionId,
            contract,
            "3",
            TOKEN_RECORD_KIND.Canonical,
        );
        await f.handler(f.root);
        expect(f.uriReads.map((row) => row.tokenId)).toEqual(["2"]);
        expect(f.published).toEqual([]);
    });
});
