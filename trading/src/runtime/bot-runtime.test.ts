import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TRADING_BOT_KIND } from "@artgod/shared/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toErrorLogFields } from "../utils/bidding-log.js";
import { bootstrapTradingBot } from "./bot-runtime.js";
import type { startBiddingRuntime as StartBiddingRuntime } from "./bidding-runtime.js";
import { createSecretEnvelopeTestFrame } from "./secret-envelope-test-fixture.js";

const mocks = vi.hoisted(() => ({
    frame: undefined as Buffer | undefined,
    releaseAfterCleanup: vi.fn(),
    stopMetrics: vi.fn(async () => undefined),
    startBiddingRuntime: vi.fn(),
    wethAllowanceCapWei: 500000000000000000n,
}));

vi.mock("./parent-secret-channel.js", () => ({
    readSecretEnvelopeFromParent: vi.fn(async () => ({
        envelope: mocks.frame,
        releaseAfterCleanup: mocks.releaseAfterCleanup,
    })),
}));

vi.mock("../config/trading-config.js", () => ({
    loadTradingConfig: vi.fn(() => ({
        chainId: 1,
        bidding: {
            enabled: true,
            wethAllowanceCapWei: mocks.wethAllowanceCapWei,
            wethApprovalMaxGasFeeWei: 10000000000000000n,
            trustOpenSeaSignedZoneTraitOffers: true,
            transactionPolicy: {
                fees: {
                    minPriorityFeePerGasWei: 100000000n,
                    maxFeePerGasWei: 10000000000n,
                },
                nonce: { pendingNoncePolicy: "fail" },
            },
        },
        metrics: {
            enabled: false,
            host: "127.0.0.1",
            ports: { biddingBot: 0 },
        },
    })),
}));

vi.mock("@artgod/shared/observability/metrics", () => ({
    initRuntimeMetrics: vi.fn(async () => ({
        metrics: {},
        stop: mocks.stopMetrics,
    })),
}));

vi.mock("./bidding-runtime.js", () => ({
    startBiddingRuntime: mocks.startBiddingRuntime,
}));

type StartBiddingRuntimeParams = Parameters<typeof StartBiddingRuntime>[0];

afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.frame = undefined;
    mocks.wethAllowanceCapWei = 500000000000000000n;
});

describe("bootstrapTradingBot", () => {
    it("wipes the source frame before bootstrap and keeps failures and lifecycle output key-free", async () => {
        const fixture = createSecretEnvelopeTestFrame();
        const bootstrapFailure = new Error(
            "Synthetic runtime bootstrap failure",
        );
        const lifecycleOutput: string[] = [];
        mocks.frame = fixture.frame;
        mocks.startBiddingRuntime.mockImplementationOnce(
            async (params: StartBiddingRuntimeParams) => {
                expect(params.signingAccount.address).toBe(fixture.address);
                expect(params).not.toHaveProperty("privateKeyHex");
                expect(params).not.toHaveProperty("privateKeyBytes");
                expect(params).not.toHaveProperty("makerAddress");
                expect(fixture.frame.every((byte) => byte === 0)).toBe(true);

                // Exercise the supervisor lifecycle boundary after the secret frame is gone.
                params.lifecycle.progress({
                    phase: "allowance_approval",
                    completed: 0,
                    total: 1,
                    detail: "bootstrap test",
                });
                throw bootstrapFailure;
            },
        );
        vi.spyOn(process.stdout, "write").mockImplementation(((
            chunk: string | Uint8Array,
        ) => {
            lifecycleOutput.push(chunk.toString());
            return true;
        }) as typeof process.stdout.write);

        let thrown: unknown;
        try {
            await bootstrapTradingBot(TRADING_BOT_KIND.Bidding);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBe(bootstrapFailure);
        expect(fixture.frame.every((byte) => byte === 0)).toBe(true);
        expect(mocks.stopMetrics).toHaveBeenCalledOnce();
        expect(mocks.releaseAfterCleanup).toHaveBeenCalledOnce();
        expect(lifecycleOutput).toHaveLength(1);

        const exposedOutput = JSON.stringify({
            lifecycleOutput,
            error: toErrorLogFields(thrown),
        });
        expect(exposedOutput).not.toContain(fixture.privateKeyHex);
        expect(exposedOutput).not.toContain(`0x${fixture.privateKeyHex}`);
    });

    it("rejects typed config drift before runtime composition", async () => {
        const fixture = createSecretEnvelopeTestFrame();
        mocks.frame = fixture.frame;
        mocks.wethAllowanceCapWei = 1n;

        await expect(
            bootstrapTradingBot(TRADING_BOT_KIND.Bidding),
        ).rejects.toThrow("does not match typed runtime config");

        expect(mocks.startBiddingRuntime).not.toHaveBeenCalled();
        expect(mocks.stopMetrics).not.toHaveBeenCalled();
        expect(fixture.frame.every((byte) => byte === 0)).toBe(true);
        expect(mocks.releaseAfterCleanup).toHaveBeenCalledOnce();
    });
});

describe("bidding signer composition", () => {
    it("constructs one account only in the immediate-wipe boundary", () => {
        const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url));
        const signingBoundarySource = readFileSync(
            path.join(runtimeDirectory, "trading-signing-authority.ts"),
            "utf8",
        );
        const biddingRuntimeSource = readFileSync(
            path.join(runtimeDirectory, "bidding-runtime.ts"),
            "utf8",
        );
        const botRuntimeSource = readFileSync(
            path.join(runtimeDirectory, "bot-runtime.ts"),
            "utf8",
        );

        expect(
            signingBoundarySource.match(/\bprivateKeyToAccount\(/g),
        ).toHaveLength(1);
        expect(biddingRuntimeSource).not.toContain("privateKeyToAccount");
        expect(biddingRuntimeSource).not.toContain("privateKeyHex");
        expect(botRuntimeSource).not.toContain("privateKeyHex");
        expect(botRuntimeSource).not.toContain("privateKeyBytes");
    });
});
