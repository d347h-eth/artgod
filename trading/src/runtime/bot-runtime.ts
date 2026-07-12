import process from "node:process";
import { initRuntimeMetrics } from "@artgod/shared/observability/metrics";
import { TRADING_BOT_KIND } from "@artgod/shared/types";
import { loadTradingConfig } from "../config/trading-config.js";
import {
    startBiddingRuntime,
    type BiddingRuntimeBootstrapPhase,
} from "./bidding-runtime.js";
import { readSecretEnvelopeFromParent } from "./parent-secret-channel.js";
import {
    type TradingBotKind,
    type TradingSecretEnvelopeMetadata,
} from "./secret-envelope.js";
import { consumeTradingSigningAuthority } from "./trading-signing-authority.js";
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

    try {
        // Consume and erase the exact frame before config or long-running runtime bootstrap begins.
        const { metadata, signingAccount } = consumeTradingSigningAuthority(
            parentSecretChannel.envelope,
            botKind,
        );

        if (botKind === TRADING_BOT_KIND.Bidding) {
            const config = loadTradingConfig();
            if (!config.bidding.enabled) {
                throw new Error(
                    "BIDDING_ENABLED is false; bidding runtime is disabled",
                );
            }
            if (config.chainId !== metadata.chainId) {
                throw new Error(
                    `Secret envelope chain mismatch: expected ${config.chainId}, received ${metadata.chainId}`,
                );
            }
            if (!metadata.biddingMandate) {
                throw new Error("Bidding secret envelope mandate is missing");
            }

            const lifecycle = createBiddingLifecyclePort(
                metadata,
                signingAccount.address,
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
                    signingAccount,
                    walletId: metadata.walletId,
                    lifecycle,
                    metrics: runtimeMetrics.metrics,
                    biddingMandate: metadata.biddingMandate,
                });

                try {
                    writeLifecyclePayload(
                        createReadyPayload(metadata, signingAccount.address),
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
            createReadyPayload(metadata, signingAccount.address),
        );
        await waitForShutdownSignal();
    } finally {
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
