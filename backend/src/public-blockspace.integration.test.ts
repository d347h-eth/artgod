import { request } from "node:http";
import { setImmediate } from "node:timers/promises";
import { join, dirname } from "node:path";
import type { FastifyInstance } from "fastify";
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance,
} from "vitest";
import { db } from "@artgod/shared/database";
import { APP_DEPLOYMENT_MODE } from "@artgod/shared/config/deployment";
import { BLOCKSPACE_QUERY_PARAMS } from "@artgod/shared/config/blockspace";
import { loadBackendConfig } from "./config.js";
import { createBaseEnv } from "./config.test-fixture.js";
import { createBackendApp } from "./index.js";
import { QUERY_CACHE_PROVIDERS } from "./ports/query-cache.js";
import {
    createBlockspaceFixture,
    BLOCKSPACE_FIXTURE_SLUG,
} from "./testing/blockspace-fixture.js";
import { ViemBackendRpcClient } from "./infra/rpc/viem-backend-rpc.js";
import { SqlitePublicBlockspaceCoverage } from "./infra/sync-backfill/sqlite-public-blockspace-coverage.js";
import { PUBLIC_BLOCKSPACE_UNAVAILABLE_ERROR } from "./application/use-cases/sync-backfill/public-blockspace-coverage.js";
import {
    QUERY_CACHE_DEBUG_HEADER_NAME,
    QUERY_CACHE_DEBUG_AGE_HEADER_NAME,
    QUERY_CACHE_DEBUG_TTL_HEADER_NAME,
    QUERY_CACHE_DEBUG_STATUSES,
} from "./utils/query-cache-debug.js";

const route = "/api/ethereum/blockspace";

describe("public blockspace production composition", () => {
    let fixture: Awaited<ReturnType<typeof createBlockspaceFixture>>;
    let app: FastifyInstance | undefined;
    let load: MockInstance<SqlitePublicBlockspaceCoverage["load"]>;

    function config(
        provider: string = QUERY_CACHE_PROVIDERS.Memory,
        mode: string = APP_DEPLOYMENT_MODE.PublicSingleCollection,
    ) {
        return loadBackendConfig({
            ...createBaseEnv(),
            ARTGOD_DB_PATH: fixture.path,
            RPC_URL_LIST: '[{"url":"http://127.0.0.1:9","weight":1}]',
            NATS_URL: "nats://127.0.0.1:9",
            PUBLIC_APP_DEPLOYMENT_MODE: mode,
            PUBLIC_APP_CHAIN_REF: "ethereum",
            PUBLIC_APP_COLLECTION_REF: BLOCKSPACE_FIXTURE_SLUG,
            BACKEND_QUERY_CACHE_PROVIDER: provider,
            COMMON_MEDIA_CACHE_DIR: join(dirname(fixture.path), "media"),
            BACKEND_PUBLIC_BLOCKSPACE_CACHE_REFRESH_MS: "60000",
        });
    }

    beforeEach(async () => {
        fixture = await createBlockspaceFixture();
        fixture.seedHead(200_000);
        fixture.seedCoverage([0, 17, 100, 180_000]);
        load = vi.spyOn(SqlitePublicBlockspaceCoverage.prototype, "load");
        vi.spyOn(
            ViemBackendRpcClient.prototype,
            "getCurrentBlockNumber",
        ).mockResolvedValue(200_000);
        vi.spyOn(
            ViemBackendRpcClient.prototype,
            "getBlockTimestamp",
        ).mockImplementation(async (block) => block * 12);
    });

    afterEach(async () => {
        await app?.close();
        app = undefined;
        vi.useRealTimers();
        vi.restoreAllMocks();
        fixture.close();
    });

    it("loads only after the registered public handler, preserving guards, parsing, and cache diagnostics", async () => {
        app = createBackendApp(config());
        await app.ready();
        await setImmediate();
        expect(load).not.toHaveBeenCalled();
        expect(
            (await app.inject({ url: "/api/other/blockspace" })).statusCode,
        ).toBe(404);
        expect(
            (
                await app.inject({
                    url: "/api/ethereum/blockspace/backfill",
                    method: "POST",
                })
            ).statusCode,
        ).toBe(404);
        for (const query of [
            `${BLOCKSPACE_QUERY_PARAMS.PageStart}=bad`,
            `${BLOCKSPACE_QUERY_PARAMS.BucketSize}=1.5`,
        ]) {
            expect(
                (await app.inject({ url: `${route}?${query}` })).statusCode,
            ).toBe(400);
        }
        expect((await app.inject({ url: `${route}/range` })).statusCode).toBe(
            400,
        );
        expect(load).not.toHaveBeenCalled();
        const invalid = await app.inject({
            url: `${route}?${BLOCKSPACE_QUERY_PARAMS.PageStart}=1&${BLOCKSPACE_QUERY_PARAMS.BucketSize}=1`,
        });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json().message).toBe(
            "page_start must align to bucket_size",
        );
        const first = await app.inject({ url: route });
        expect(first.statusCode).toBe(200);
        expect(first.json().summary.syncedBlockCount).toBe(3);
        expect(first.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()]).toBe(
            QUERY_CACHE_DEBUG_STATUSES.Miss,
        );
        const hit = await app.inject({ url: route });
        expect(hit.body).toBe(first.body);
        expect(hit.headers[QUERY_CACHE_DEBUG_HEADER_NAME.toLowerCase()]).toBe(
            QUERY_CACHE_DEBUG_STATUSES.Hit,
        );
        expect(
            Number(
                hit.headers[QUERY_CACHE_DEBUG_AGE_HEADER_NAME.toLowerCase()],
            ),
        ).toBeGreaterThanOrEqual(0);
        expect(
            Number(
                hit.headers[QUERY_CACHE_DEBUG_TTL_HEADER_NAME.toLowerCase()],
            ),
        ).toBe(60000);
        expect(load).toHaveBeenCalledTimes(1);
        // Existing public handlers fix collection scope and ignore this query dimension.
        expect(
            (
                await app.inject({
                    url: `${route}?${BLOCKSPACE_QUERY_PARAMS.Collection}=other`,
                })
            ).body,
        ).toBe(first.body);
        expect(
            (
                await app.inject({
                    url: `${route}/range?${BLOCKSPACE_QUERY_PARAMS.FromBlock}=17&${BLOCKSPACE_QUERY_PARAMS.ToBlock}=100`,
                })
            ).json().range.syncedBlockCount,
        ).toBe(2);
    });

    it.each([
        [
            QUERY_CACHE_PROVIDERS.Disabled,
            APP_DEPLOYMENT_MODE.PublicSingleCollection,
        ],
        [QUERY_CACHE_PROVIDERS.Memory, APP_DEPLOYMENT_MODE.Standard],
    ])(
        "preserves raw repository behavior with provider %s in mode %s",
        async (provider, mode) => {
            app = createBackendApp(config(provider, mode));
            const response = await app.inject({
                url: `${route}?${BLOCKSPACE_QUERY_PARAMS.Collection}=${BLOCKSPACE_FIXTURE_SLUG}`,
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().summary.syncedBlockCount).toBe(4);
            expect(load).not.toHaveBeenCalled();
        },
    );

    it("maps cold operational failures to an actionable 503 and missing scope to 404", async () => {
        app = createBackendApp(config());
        load.mockRejectedValueOnce(new Error("private database detail"));
        const unavailable = await app.inject({ url: route });
        expect(unavailable.statusCode).toBe(503);
        expect(unavailable.json()).toEqual({
            error: PUBLIC_BLOCKSPACE_UNAVAILABLE_ERROR,
            message:
                "Blockspace is temporarily unavailable. Try again shortly.",
        });
        expect(unavailable.body).not.toContain("private database detail");
        await app.close();
        db.prepare(
            "UPDATE collections SET bootstrap_anchor_block=NULL WHERE collection_id=?",
        ).run(fixture.collectionId);
        app = createBackendApp(config());
        const missing = await app.inject({ url: route });
        expect(missing.statusCode).toBe(404);
        expect(missing.json().message).toBe("Unknown blockspace collection");
    });

    it("cancels an actual socket request during preClose and releases its private read view", async () => {
        app = createBackendApp(config());
        let opened!: () => void;
        const started = new Promise<void>((resolve) => {
            opened = resolve;
        });
        load.mockRestore();
        const realLoad = SqlitePublicBlockspaceCoverage.prototype.load;
        load = vi
            .spyOn(SqlitePublicBlockspaceCoverage.prototype, "load")
            .mockImplementation(function (
                this: SqlitePublicBlockspaceCoverage,
                scope,
                signal,
            ) {
                const result = realLoad.call(this, scope, signal);
                opened();
                return result;
            });
        await app.listen({ host: "127.0.0.1", port: 0 });
        const address = app.server.address();
        if (!address || typeof address === "string")
            throw new Error("Expected a TCP listener");
        const response = new Promise<{ status: number; body: string }>(
            (resolve, reject) => {
                const req = request(
                    {
                        host: "127.0.0.1",
                        port: address.port,
                        path: route,
                        agent: false,
                    },
                    (res) => {
                        let body = "";
                        res.setEncoding("utf8");
                        res.on("data", (chunk) => {
                            body += chunk;
                        });
                        res.on("end", () =>
                            resolve({ status: res.statusCode!, body }),
                        );
                    },
                );
                req.on("error", reject);
                req.end();
            },
        );
        await started;
        const closing = app.close();
        expect((await response).status).toBe(503);
        await closing;
        expect(
            ViemBackendRpcClient.prototype.getCurrentBlockNumber,
        ).not.toHaveBeenCalled();
        expect(db.raw.pragma("wal_checkpoint(TRUNCATE)")).toEqual([
            { busy: 0, log: 0, checkpointed: 0 },
        ]);
        expect(load).toHaveBeenCalledTimes(1);
    });
});
