import process from "node:process";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { loadTradingConfig } from "../config/trading-config.js";
import {
    startBiddingRuntime,
    type BiddingRuntimeBootstrapPhase,
} from "./bidding-runtime.js";
import { readSecretEnvelopeFromParent } from "./parent-secret-channel.js";
import {
    parseSecretEnvelope,
    type TradingBotKind,
    type TradingSecretEnvelopeMetadata,
} from "./secret-envelope.js";
import {
    TRADING_METRICS_LOG_COMPONENT,
    TRADING_METRICS_PREFIX,
    TRADING_METRICS_WORKER,
} from "./observability.js";

type BaseLifecyclePayload = {
    botKind: TradingBotKind;
    walletId: string;
    address: string;
    chainId: number;
};

type BootstrappingPayload = BaseLifecyclePayload & {
    event: "bot_bootstrapping";
    phase: BiddingRuntimeBootstrapPhase;
    completed: number;
    total: number;
    detail: string;
};

type BootstrapProgressPayload = BaseLifecyclePayload & {
    event: "bot_bootstrap_progress";
    phase: BiddingRuntimeBootstrapPhase;
    completed: number;
    total: number;
    detail: string;
};

type ReadyPayload = BaseLifecyclePayload & {
    event: "bot_ready";
};

type TradingBotLifecyclePayload =
    | BootstrappingPayload
    | BootstrapProgressPayload
    | ReadyPayload;

const PARENT_LIVENESS_FAILURE_EXIT_CODE = 1;

export async function bootstrapTradingBot(
    botKind: TradingBotKind,
): Promise<void> {
    const parentSecretChannel = await readSecretEnvelopeFromParent(
        process.stdin,
        exitAfterParentChannelFailure,
    );
    const envelopeBuffer = parentSecretChannel.envelope;
    let privateKeyHex = "";

    try {
        const envelope = parseSecretEnvelope(envelopeBuffer);
        if (envelope.metadata.botKind !== botKind) {
            throw new Error(
                `Secret envelope bot kind mismatch: expected ${botKind}, received ${envelope.metadata.botKind}`,
            );
        }

        privateKeyHex = `0x${envelope.privateKeyBytes.toString("hex")}`;
        const account = privateKeyToAccount(privateKeyHex as Hex);
        if (
            account.address.toLowerCase() !==
            envelope.metadata.address.toLowerCase()
        ) {
            throw new Error(
                `Derived address mismatch: expected ${envelope.metadata.address}, received ${account.address}`,
            );
        }

        if (botKind === "bidding") {
            const config = loadTradingConfig();
            if (!config.bidding.enabled) {
                throw new Error(
                    "BIDDING_ENABLED is false; bidding runtime is disabled",
                );
            }
            if (config.chainId !== envelope.metadata.chainId) {
                throw new Error(
                    `Secret envelope chain mismatch: expected ${config.chainId}, received ${envelope.metadata.chainId}`,
                );
            }
            if (!envelope.metadata.biddingMandate) {
                throw new Error("Bidding secret envelope mandate is missing");
            }

            const lifecycle = createBiddingLifecyclePort(
                envelope.metadata,
                account.address,
            );
            const runtimeMetrics = await initRuntimeMetrics({
                enabled: config.metrics.enabled,
                host: config.metrics.host,
                port: config.metrics.ports.biddingBot,
                prefix: TRADING_METRICS_PREFIX,
                worker: TRADING_METRICS_WORKER.BiddingBot,
                chainId: config.chainId,
                logComponent: TRADING_METRICS_LOG_COMPONENT,
            });
            try {
                // Bootstrap the real bidder runtime before emitting bot_ready to the desktop supervisor.
                const runtime = await startBiddingRuntime({
                    config,
                    biddingConfig: config.bidding,
                    privateKeyHex: privateKeyHex as Hex,
                    makerAddress: account.address,
                    walletId: envelope.metadata.walletId,
                    lifecycle,
                    metrics: runtimeMetrics.metrics,
                    biddingMandate: envelope.metadata.biddingMandate,
                });

                try {
                    writeLifecyclePayload(
                        createReadyPayload(envelope.metadata, account.address),
                    );

                    await waitForShutdownSignal();
                } finally {
                    await runtime.shutdown();
                }
            } finally {
                await runtimeMetrics.stop();
            }
            return;
        }

        writeLifecyclePayload(
            createReadyPayload(envelope.metadata, account.address),
        );
        await waitForShutdownSignal();
    } finally {
        envelopeBuffer.fill(0);
        if (privateKeyHex.length > 0) {
            privateKeyHex = "0x";
        }
        // Release stdin only after runtime and metrics cleanup so graceful SIGTERM can exit.
        parentSecretChannel.releaseAfterCleanup();
    }
}

function exitAfterParentChannelFailure(_error: Error): never {
    process.exit(PARENT_LIVENESS_FAILURE_EXIT_CODE);
}

function waitForShutdownSignal(): Promise<void> {
    return new Promise<void>((resolve) => {
        const shutdown = () => {
            process.off("SIGTERM", shutdown);
            process.off("SIGINT", shutdown);
            resolve();
        };

        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
    });
}

function createBiddingLifecyclePort(
    metadata: TradingSecretEnvelopeMetadata,
    address: string,
): {
    bootstrapping(payload: {
        phase: BiddingRuntimeBootstrapPhase;
        completed: number;
        total: number;
        detail: string;
    }): void;
    progress(payload: {
        phase: BiddingRuntimeBootstrapPhase;
        completed: number;
        total: number;
        detail: string;
    }): void;
} {
    return {
        // Emit the first bootstrapping handshake before long snapshot/price warmup work continues.
        bootstrapping(payload) {
            writeLifecyclePayload({
                event: "bot_bootstrapping",
                botKind: metadata.botKind,
                walletId: metadata.walletId,
                address,
                chainId: metadata.chainId,
                phase: payload.phase,
                completed: payload.completed,
                total: payload.total,
                detail: payload.detail,
            });
        },
        // Emit incremental bootstrap progress so the supervisor can treat stalls as runtime failures instead of startup failures.
        progress(payload) {
            writeLifecyclePayload({
                event: "bot_bootstrap_progress",
                botKind: metadata.botKind,
                walletId: metadata.walletId,
                address,
                chainId: metadata.chainId,
                phase: payload.phase,
                completed: payload.completed,
                total: payload.total,
                detail: payload.detail,
            });
        },
    };
}

function createReadyPayload(
    metadata: TradingSecretEnvelopeMetadata,
    address: string,
): ReadyPayload {
    return {
        event: "bot_ready",
        botKind: metadata.botKind,
        walletId: metadata.walletId,
        address,
        chainId: metadata.chainId,
    };
}

function writeLifecyclePayload(payload: TradingBotLifecyclePayload): void {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
}
