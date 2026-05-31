#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { fileURLToPath } from "node:url";
import { resolveRpcEndpointUrl } from "./config/rpc-endpoint-pool.mjs";

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i += 1) {
        const value = argv[i];
        if (!value) continue;
        if (value === "--help" || value === "-h") {
            args.help = true;
            continue;
        }
        if (value === "--compact") {
            args.compact = true;
            continue;
        }
        if (value.startsWith("--rpc=")) {
            args.rpc = value.split("=", 2)[1];
            continue;
        }
        if (value.startsWith("--tx=")) {
            args.tx = value.split("=", 2)[1];
            continue;
        }
        if (value.startsWith("--out=")) {
            args.out = value.split("=", 2)[1];
            continue;
        }
        if (value === "--rpc") {
            args.rpc = argv[i + 1];
            i += 1;
            continue;
        }
        if (value === "--tx") {
            args.tx = argv[i + 1];
            i += 1;
            continue;
        }
        if (value === "--out") {
            args.out = argv[i + 1];
            i += 1;
            continue;
        }
    }
    return args;
}

function usage() {
    return [
        "Usage: yarn node scripts/dump-tx.js --rpc <url> --tx <hash> [--out <path>] [--compact]",
        "",
        "Options:",
        "  --rpc     JSON-RPC URL override; RPC_URL env uses the endpoint JSON array",
        "  --tx      Transaction hash (or set TX_HASH in env)",
        "  --out     Output path (default: tmp/tx/<hash>.json)",
        "  --compact Write compact JSON (default: pretty-printed)",
    ].join("\n");
}

function loadConfig(env, argv) {
    const args = parseArgs(argv);
    if (args.help) {
        return { help: true };
    }
    const rpcUrl = resolveRpcEndpointUrl({
        cliValue: args.rpc,
        envValue: env.RPC_URL,
    });
    const txHash = args.tx ?? env.TX_HASH;
    if (!rpcUrl || !txHash) {
        throw new Error(`Missing RPC_URL or TX_HASH.\n${usage()}`);
    }
    const outPath = resolveOutputPath(args.out, txHash);
    return {
        rpcUrl,
        txHash,
        outPath,
        compact: Boolean(args.compact),
    };
}

function resolveOutputPath(outPath, txHash) {
    const fileName = `${txHash}.json`;
    const target = outPath ?? path.join("tmp", "tx", fileName);
    if (path.isAbsolute(target)) return target;
    return path.resolve(getProjectRoot(), target);
}

function getProjectRoot() {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, "..");
}

function serializeJson(value, compact) {
    const json = JSON.stringify(
        value,
        (_key, item) => (typeof item === "bigint" ? item.toString() : item),
        compact ? 0 : 2,
    );
    return compact ? json : `${json}\n`;
}

async function main() {
    const config = loadConfig(process.env, process.argv);
    if (config.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }

    const client = createPublicClient({
        transport: http(config.rpcUrl),
    });

    const tx = await client.getTransaction({
        hash: config.txHash,
    });
    const receipt = await client.getTransactionReceipt({
        hash: config.txHash,
    });
    if (!receipt?.blockHash) {
        throw new Error("Transaction is not mined yet (missing blockHash).");
    }
    const block = await client.getBlock({
        blockHash: receipt.blockHash,
        includeTransactions: false,
    });

    const payload = { tx, receipt, block };
    await fs.mkdir(path.dirname(config.outPath), { recursive: true });
    await fs.writeFile(
        config.outPath,
        serializeJson(payload, config.compact),
        "utf8",
    );

    process.stdout.write(`Wrote ${config.outPath}\n`);
}

main().catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
});
