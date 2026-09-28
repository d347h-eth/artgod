import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
    BOOTSTRAP_OPERATION as Operation,
    BOOTSTRAP_OUTPUT_STEP as Step,
    BOOTSTRAP_OUTPUT_STATUS as Status,
    BOOTSTRAP_STREAM_CONTENT_TYPE,
    BOOTSTRAP_STREAM_RECORD as RecordType,
    BOOTSTRAP_QUEUE_RESPONSE_UNAVAILABLE_MESSAGE,
    type BootstrapOperation,
    type BootstrapStreamRecord,
} from "@artgod/shared/bootstrap/operation-output";
import {
    BOOTSTRAP_API_ROUTE_TEMPLATE,
    buildProbeBootstrapCollectionPath,
} from "@artgod/shared/http/bootstrap-routes";
import {
    BOOTSTRAP_TEST_ADDRESS,
    BOOTSTRAP_TEST_CHAIN,
} from "@artgod/shared/testing/bootstrap-probe";
import { BootstrapValidationError } from "../../../application/use-cases/bootstrap/types.js";
import { registerApiErrorHandlers } from "../../common/error-handlers.js";
import { bootstrapOperationResponse } from "./operation-response.js";

describe("bootstrap operation response", () => {
    const apps: ReturnType<typeof Fastify>[] = [];
    afterEach(async () => {
        await Promise.all(apps.splice(0).map((app) => app.close()));
    });
    const path = buildProbeBootstrapCollectionPath({
        chainRef: BOOTSTRAP_TEST_CHAIN.slug,
        address: BOOTSTRAP_TEST_ADDRESS,
        standard: "erc721",
    });
    function fixture(
        fail: boolean | Error = false,
        operation: BootstrapOperation = Operation.Probe,
    ) {
        const app = Fastify();
        apps.push(app);
        registerApiErrorHandlers(app);
        app.get(
            BOOTSTRAP_API_ROUTE_TEMPLATE.ProbeCollection,
            (request, reply) =>
                bootstrapOperationResponse(
                    request,
                    reply,
                    operation,
                    async (report) => {
                        report?.({
                            step: Step.Supply,
                            status: Status.Succeeded,
                            message: "Contract total supply: 3333",
                        });
                        if (fail instanceof Error) throw fail;
                        if (fail)
                            throw new BootstrapValidationError(
                                "Check the address and retry.",
                            );
                        return { supply: 3333 };
                    },
                ),
        );
        return app;
    }
    it("preserves JSON consumers and serializes ordered progress plus one final result", async () => {
        const app = fixture();
        expect((await app.inject(path)).json()).toEqual({ supply: 3333 });
        const response = await app.inject({
            url: path,
            headers: { accept: BOOTSTRAP_STREAM_CONTENT_TYPE },
        });
        expect(response.headers["content-type"]).toContain(
            BOOTSTRAP_STREAM_CONTENT_TYPE,
        );
        const records = response.body
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(records.map((record) => record.type)).toEqual([
            RecordType.Progress,
            RecordType.Progress,
            RecordType.Progress,
            RecordType.Result,
        ]);
        expect(records.slice(0, -1).map((record) => record.sequence)).toEqual([
            1, 2, 3,
        ]);
        expect(records.at(-1).result).toEqual({ supply: 3333 });
    });
    it("maps failures after headers to a terminal error without losing completed checks", async () => {
        const app = fixture(true);
        expect((await app.inject(path)).statusCode).toBe(422);
        const response = await app.inject({
            url: path,
            headers: { accept: BOOTSTRAP_STREAM_CONTENT_TYPE },
        });
        const records = response.body
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(records[1].message).toContain("3333");
        expect(records.at(-1)).toEqual({
            type: RecordType.Error,
            statusCode: 422,
            error: "validation_error",
            message: "Check the address and retry.",
        });
        expect(
            records.some((record) => record.type === RecordType.Result),
        ).toBe(false);
    });
    it("delivers progress to an HTTP reader before the slow operation finishes", async () => {
        let complete!: () => void;
        const pending = new Promise<void>((resolve) => {
            complete = resolve;
        });
        const app = Fastify();
        apps.push(app);
        app.get(
            BOOTSTRAP_API_ROUTE_TEMPLATE.ProbeCollection,
            (request, reply) =>
                bootstrapOperationResponse(
                    request,
                    reply,
                    Operation.Probe,
                    async (report) => {
                        report?.({
                            step: Step.Metadata,
                            status: Status.Started,
                            message: "Waiting for metadata",
                            url: "https://example.com/token/1000",
                        });
                        await pending;
                        return { done: true };
                    },
                ),
        );
        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const response = await fetch(origin + path, {
            headers: { accept: BOOTSTRAP_STREAM_CONTENT_TYPE },
        });
        const reader = response.body!.getReader();
        try {
            const decoder = new TextDecoder();
            let first = "";
            // HTTP chunks need not coincide with complete output records.
            while (first.split("\n").length < 3) {
                const { done, value } = await reader.read();
                if (done) break;
                first += decoder.decode(value, { stream: true });
            }
            const records = first
                .trim()
                .split("\n")
                .map((line) =>
                    JSON.parse(line),
                ) as BootstrapStreamRecord<unknown>[];
            expect(
                records.every((record) => record.type === RecordType.Progress),
            ).toBe(true);
            expect(first).toContain("Waiting for metadata");
        } finally {
            complete();
            await reader.cancel();
        }
    });
    it("keeps an unknown queue outcome distinct from a rejected definition", async () => {
        const app = fixture(
            new Error("Private transport detail"),
            Operation.Queue,
        );
        const response = await app.inject({
            url: path,
            headers: { accept: BOOTSTRAP_STREAM_CONTENT_TYPE },
        });
        const records = response.body
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        expect(records.at(-1)).toMatchObject({
            type: RecordType.Error,
            statusCode: 500,
            message: BOOTSTRAP_QUEUE_RESPONSE_UNAVAILABLE_MESSAGE,
        });
        expect(response.body).not.toContain("Private transport detail");
    });
});
