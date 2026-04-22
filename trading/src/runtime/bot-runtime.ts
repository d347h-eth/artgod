import { Buffer } from "node:buffer";
import process from "node:process";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { loadTradingConfig } from "../config/trading-config.js";
import {
    startBiddingRuntime,
    type BiddingRuntimeBootstrapPhase,
} from "./bidding-runtime.js";
import {
    parseSecretEnvelope,
    type TradingBotKind,
    type TradingSecretEnvelopeMetadata,
} from "./secret-envelope.js";

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

export async function bootstrapTradingBot(
    botKind: TradingBotKind,
): Promise<void> {
    const envelopeBuffer = await readAllStdin();
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

            const lifecycle = createBiddingLifecyclePort(
                envelope.metadata,
                account.address,
            );
            // Bootstrap the real bidder runtime before emitting bot_ready to the desktop supervisor.
            const runtime = await startBiddingRuntime({
                config,
                biddingConfig: config.bidding,
                privateKeyHex: privateKeyHex as Hex,
                makerAddress: account.address,
                lifecycle,
            });

            writeLifecyclePayload(
                createReadyPayload(envelope.metadata, account.address),
            );

            await waitForShutdownSignal();
            await runtime.shutdown();
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
    }
}

async function readAllStdin(): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    for (const chunk of chunks) {
        chunk.fill(0);
    }
    chunks.length = 0;
    if (buffer.length === 0) {
        throw new Error("Secret envelope is missing");
    }
    return buffer;
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
