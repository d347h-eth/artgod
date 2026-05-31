#!/usr/bin/env node
import "dotenv/config";
import {
    createPublicClient,
    createWalletClient,
    formatEther,
    formatGwei,
    getAddress,
    http,
    isHash,
    parseGwei,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { resolveRpcEndpointUrl } from "../config/rpc-endpoint-pool.mjs";

function parseArgs(argv) {
    const args = {
        tx: [],
    };

    for (let i = 2; i < argv.length; i += 1) {
        const value = argv[i];
        if (!value) continue;
        if (value === "--help" || value === "-h") {
            args.help = true;
            continue;
        }
        if (value === "--send-self-transfer") {
            args.sendSelfTransfer = true;
            continue;
        }
        if (value === "--confirm-mainnet-send") {
            args.confirmMainnetSend = true;
            continue;
        }
        if (value.startsWith("--rpc=")) {
            args.rpc = value.slice("--rpc=".length);
            continue;
        }
        if (value.startsWith("--address=")) {
            args.address = value.slice("--address=".length);
            continue;
        }
        if (value.startsWith("--private-key=")) {
            args.privateKey = value.slice("--private-key=".length);
            continue;
        }
        if (value.startsWith("--tx=")) {
            args.tx.push(value.slice("--tx=".length));
            continue;
        }
        if (value.startsWith("--max-fee-gwei=")) {
            args.maxFeeGwei = value.slice("--max-fee-gwei=".length);
            continue;
        }
        if (value.startsWith("--priority-fee-gwei=")) {
            args.priorityFeeGwei = value.slice("--priority-fee-gwei=".length);
            continue;
        }
        if (value.startsWith("--nonce=")) {
            args.nonce = value.slice("--nonce=".length);
            continue;
        }
        if (value === "--rpc") {
            args.rpc = argv[i + 1];
            i += 1;
            continue;
        }
        if (value === "--address") {
            args.address = argv[i + 1];
            i += 1;
            continue;
        }
        if (value === "--private-key") {
            args.privateKey = argv[i + 1];
            i += 1;
            continue;
        }
        if (value === "--tx") {
            args.tx.push(argv[i + 1]);
            i += 1;
            continue;
        }
        if (value === "--max-fee-gwei") {
            args.maxFeeGwei = argv[i + 1];
            i += 1;
            continue;
        }
        if (value === "--priority-fee-gwei") {
            args.priorityFeeGwei = argv[i + 1];
            i += 1;
            continue;
        }
        if (value === "--nonce") {
            args.nonce = argv[i + 1];
            i += 1;
            continue;
        }
    }

    return args;
}

function usage() {
    return [
        "Usage: yarn debug:ethereum-node --address <0x...> [--tx <hash>...]",
        "       yarn debug:ethereum-node --private-key <0x...> --send-self-transfer --confirm-mainnet-send",
        "",
        "Options:",
        "  --rpc                  JSON-RPC URL override; RPC_URL env uses the endpoint JSON array",
        "  --address              Account address to inspect",
        "  --tx                   Transaction hash to inspect; may be repeated",
        "  --send-self-transfer   Broadcast a 0 ETH self-transfer to test send path",
        "  --private-key          Private key for --send-self-transfer, defaults to PRIVATE_KEY",
        "  --confirm-mainnet-send Required for --send-self-transfer on chainId=1",
        "  --max-fee-gwei         Optional EIP-1559 maxFeePerGas for self-transfer",
        "  --priority-fee-gwei    Optional EIP-1559 maxPriorityFeePerGas for self-transfer",
        "  --nonce                Optional nonce for self-transfer",
        "",
        "Read-only mode also tries txpool_status and txpool_contentFrom when the node exposes txpool RPC.",
    ].join("\n");
}

function loadConfig(env, argv) {
    const args = parseArgs(argv);
    if (args.help) {
        return { help: true };
    }

    const privateKey = args.privateKey ?? env.PRIVATE_KEY;
    const account = privateKey
        ? privateKeyToAccount(asPrivateKey(privateKey))
        : null;
    const address = args.address ?? account?.address;
    const rpcUrl = resolveRpcEndpointUrl({
        cliValue: args.rpc,
        envValue: env.RPC_URL,
    });

    if (!rpcUrl) {
        throw new Error(`Missing RPC_URL.\n${usage()}`);
    }
    if (!address) {
        throw new Error(`Missing account address.\n${usage()}`);
    }

    for (const txHash of args.tx) {
        if (!isHash(txHash)) {
            throw new Error(`Invalid --tx hash: ${txHash}`);
        }
    }

    return {
        help: false,
        rpcUrl,
        address: getAddress(address),
        txHashes: args.tx,
        account,
        sendSelfTransfer: Boolean(args.sendSelfTransfer),
        confirmMainnetSend: Boolean(args.confirmMainnetSend),
        maxFeePerGas:
            args.maxFeeGwei === undefined
                ? undefined
                : parseGwei(args.maxFeeGwei),
        maxPriorityFeePerGas:
            args.priorityFeeGwei === undefined
                ? undefined
                : parseGwei(args.priorityFeeGwei),
        nonce: args.nonce === undefined ? undefined : parseNonce(args.nonce),
    };
}

function asPrivateKey(value) {
    const normalized = value.trim();
    return normalized.startsWith("0x") ? normalized : `0x${normalized}`;
}

function parseNonce(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
        throw new Error(`Invalid nonce: ${value}`);
    }
    return parsed;
}

async function main() {
    const config = loadConfig(process.env, process.argv);
    if (config.help) {
        process.stdout.write(`${usage()}\n`);
        return;
    }

    const publicClient = createPublicClient({
        transport: http(config.rpcUrl),
    });

    const chainId = await publicClient.getChainId();
    printHeader("Node");
    printLine("chainId", chainId.toString());
    await inspectNodeHealth(publicClient);

    await inspectAccount(publicClient, config.address);
    await inspectTxPool(publicClient, config.address);
    for (const txHash of config.txHashes) {
        await inspectTransaction(publicClient, txHash);
    }

    if (config.sendSelfTransfer) {
        await sendSelfTransfer(publicClient, config, chainId);
    }
}

async function inspectNodeHealth(client) {
    const [syncing, peerCount] = await Promise.all([
        requestOptional(client, "eth_syncing", []),
        requestOptional(client, "net_peerCount", []),
    ]);

    printLine("syncing", syncing.ok ? serialize(syncing.value) : syncing.error);
    printLine(
        "peerCount",
        peerCount.ok ? formatRpcQuantity(peerCount.value) : peerCount.error,
    );
}

async function inspectAccount(client, address) {
    printHeader("Account");
    printLine("address", address);

    const [block, feeData, gasPrice, balance, latestNonce, pendingNonce] =
        await Promise.all([
            client.getBlock({ blockTag: "latest" }),
            client.estimateFeesPerGas().catch((error) => ({ error })),
            client.getGasPrice().catch((error) => ({ error })),
            client.getBalance({ address }),
            client.getTransactionCount({ address, blockTag: "latest" }),
            client.getTransactionCount({ address, blockTag: "pending" }),
        ]);

    printLine("latestBlock", formatOptionalInteger(block.number));
    printLine("baseFee", formatOptionalGwei(block.baseFeePerGas ?? null));
    printLine("gasPrice", formatMaybeGwei(gasPrice));
    if ("error" in feeData) {
        printLine("feeData", `error=${formatError(feeData.error)}`);
    } else {
        printLine(
            "feeData.gasPrice",
            formatOptionalGwei(feeData.gasPrice ?? null),
        );
        printLine(
            "feeData.maxFeePerGas",
            formatOptionalGwei(feeData.maxFeePerGas ?? null),
        );
        printLine(
            "feeData.maxPriorityFeePerGas",
            formatOptionalGwei(feeData.maxPriorityFeePerGas ?? null),
        );
    }
    printLine("balance", `${formatEther(balance)} ETH`);
    printLine("latestNonce", latestNonce.toString());
    printLine("pendingNonce", pendingNonce.toString());
    printLine(
        "pendingNonceGap",
        Math.max(0, pendingNonce - latestNonce).toString(),
    );
}

async function inspectTxPool(client, address) {
    printHeader("Txpool");

    const status = await requestOptional(client, "txpool_status", []);
    printLine(
        "txpool_status",
        status.ok ? serialize(status.value) : status.error,
    );

    const content = await requestOptional(client, "txpool_contentFrom", [
        address,
    ]);
    if (!content.ok) {
        printLine("txpool_contentFrom", content.error);
        return;
    }

    const pending = normalizeTxPoolBucket(content.value?.pending);
    const queued = normalizeTxPoolBucket(content.value?.queued);
    printLine("pendingCount", pending.length.toString());
    printLine("queuedCount", queued.length.toString());

    for (const tx of pending) {
        printTxPoolEntry("pending", tx);
    }
    for (const tx of queued) {
        printTxPoolEntry("queued", tx);
    }
}

async function inspectTransaction(client, txHash) {
    printHeader(`Transaction ${txHash}`);

    const transaction = await client
        .getTransaction({ hash: txHash })
        .catch((error) => ({ error }));
    if ("error" in transaction) {
        printLine("transaction", `error=${formatError(transaction.error)}`);
    } else {
        printTransactionSummary(transaction);
    }

    const receipt = await client
        .getTransactionReceipt({ hash: txHash })
        .catch((error) => ({ error }));
    if ("error" in receipt) {
        printLine("receipt", `error=${formatError(receipt.error)}`);
        return;
    }

    printLine("receipt.status", receipt.status);
    printLine(
        "receipt.blockNumber",
        formatOptionalInteger(receipt.blockNumber),
    );
    printLine("receipt.gasUsed", receipt.gasUsed.toString());
    printLine(
        "receipt.effectiveGasPrice",
        formatOptionalGwei(receipt.effectiveGasPrice ?? null),
    );
}

async function sendSelfTransfer(publicClient, config, chainId) {
    printHeader("Self Transfer");
    if (!config.account) {
        throw new Error(
            "--send-self-transfer requires --private-key or PRIVATE_KEY.",
        );
    }
    if (config.account.address !== config.address) {
        throw new Error(
            `Private key address ${config.account.address} does not match inspected address ${config.address}.`,
        );
    }
    if (chainId === 1 && !config.confirmMainnetSend) {
        throw new Error(
            "Refusing to broadcast on mainnet without --confirm-mainnet-send.",
        );
    }

    const gasEstimate = await publicClient.estimateGas({
        account: config.account.address,
        to: config.account.address,
        value: 0n,
    });
    printLine("gasEstimate", gasEstimate.toString());

    const walletClient = createWalletClient({
        account: config.account,
        chain: chainId === 1 ? mainnet : undefined,
        transport: http(config.rpcUrl),
    });
    const txHash = await walletClient.sendTransaction({
        account: config.account,
        to: config.account.address,
        value: 0n,
        nonce: config.nonce,
        maxFeePerGas: config.maxFeePerGas,
        maxPriorityFeePerGas: config.maxPriorityFeePerGas,
    });

    printLine("submittedTx", txHash);
    const transaction = await publicClient.getTransaction({ hash: txHash });
    printTransactionSummary(transaction);
}

async function requestOptional(client, method, params) {
    try {
        return {
            ok: true,
            value: await client.request({ method, params }),
        };
    } catch (error) {
        return {
            ok: false,
            error: formatError(error),
        };
    }
}

function normalizeTxPoolBucket(bucket) {
    if (!bucket || typeof bucket !== "object") {
        return [];
    }
    return Object.entries(bucket)
        .map(([nonce, tx]) => ({ nonce, tx }))
        .sort((left, right) => Number(left.nonce) - Number(right.nonce));
}

function printTxPoolEntry(kind, entry) {
    const tx = entry.tx;
    printLine(
        `${kind}.${entry.nonce}`,
        [
            `hash=${tx.hash ?? "n/a"}`,
            `nonce=${formatHexInteger(tx.nonce ?? entry.nonce)}`,
            `to=${tx.to ?? "n/a"}`,
            `value=${formatHexEther(tx.value)}`,
            `gas=${formatHexInteger(tx.gas)}`,
            `gasPrice=${formatHexGwei(tx.gasPrice)}`,
            `maxFeePerGas=${formatHexGwei(tx.maxFeePerGas)}`,
            `maxPriorityFeePerGas=${formatHexGwei(tx.maxPriorityFeePerGas)}`,
        ].join(", "),
    );
}

function printTransactionSummary(transaction) {
    printLine("hash", transaction.hash);
    printLine("type", transaction.type ?? "unknown");
    printLine("nonce", transaction.nonce.toString());
    printLine("from", transaction.from);
    printLine("to", transaction.to ?? "contract_creation");
    printLine("value", `${formatEther(transaction.value)} ETH`);
    printLine("gasLimit", transaction.gas.toString());
    printLine("gasPrice", formatOptionalGwei(transaction.gasPrice ?? null));
    printLine(
        "maxFeePerGas",
        formatOptionalGwei(transaction.maxFeePerGas ?? null),
    );
    printLine(
        "maxPriorityFeePerGas",
        formatOptionalGwei(transaction.maxPriorityFeePerGas ?? null),
    );
    printLine(
        "blockNumber",
        formatOptionalInteger(transaction.blockNumber ?? null),
    );
    printLine("blockHash", transaction.blockHash ?? "pending");
}

function printHeader(label) {
    process.stdout.write(`\n== ${label} ==\n`);
}

function printLine(key, value) {
    process.stdout.write(`${key}: ${value}\n`);
}

function serialize(value) {
    return JSON.stringify(value, (_key, item) =>
        typeof item === "bigint" ? item.toString() : item,
    );
}

function formatMaybeGwei(value) {
    return typeof value === "bigint"
        ? formatOptionalGwei(value)
        : `error=${formatError(value.error)}`;
}

function formatOptionalGwei(value) {
    return value === null || value === undefined
        ? "n/a"
        : `${formatGwei(value)} gwei`;
}

function formatOptionalInteger(value) {
    return value === null || value === undefined ? "n/a" : value.toString();
}

function formatHexInteger(value) {
    if (value === null || value === undefined) return "n/a";
    if (typeof value === "number") return value.toString();
    if (typeof value !== "string") return String(value);
    return BigInt(value).toString();
}

function formatRpcQuantity(value) {
    if (typeof value !== "string") return serialize(value);
    return `${BigInt(value).toString()} (${value})`;
}

function formatHexGwei(value) {
    if (value === null || value === undefined) return "n/a";
    return `${formatGwei(BigInt(value))} gwei`;
}

function formatHexEther(value) {
    if (value === null || value === undefined) return "n/a";
    return `${formatEther(BigInt(value))} ETH`;
}

function formatError(error) {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message;
    }
    return String(error);
}

main().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exit(1);
});
