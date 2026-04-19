import { Buffer } from "node:buffer";
import process from "node:process";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { loadBiddingJobsFromFile } from "../adapters/config/bidding-jobs-file.js";
import { loadTradingConfig } from "../config/trading-config.js";
import { parseSecretEnvelope, type TradingBotKind } from "./secret-envelope.js";

type ReadyPayload = {
    event: "bot_ready";
    botKind: TradingBotKind;
    walletId: string;
    address: string;
    chainId: number;
};

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

            await loadBiddingJobsFromFile(config.bidding.jobsFile);
        }

        const readyPayload: ReadyPayload = {
            event: "bot_ready",
            botKind,
            walletId: envelope.metadata.walletId,
            address: account.address,
            chainId: envelope.metadata.chainId,
        };
        process.stdout.write(`${JSON.stringify(readyPayload)}\n`);

        const keepAlive = setInterval(() => {
            // Keep the placeholder runtime alive until the supervisor stops it.
        }, 60_000);

        await new Promise<void>((resolve) => {
            const shutdown = () => {
                clearInterval(keepAlive);
                resolve();
            };
            process.once("SIGTERM", shutdown);
            process.once("SIGINT", shutdown);
        });
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
