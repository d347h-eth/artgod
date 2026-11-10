import {
    EMPTY_BLOOM,
    ZERO_ADDRESS,
    ZERO_HASH,
    fulfilledLog,
    hashIdentity,
    prepareMarketOrder,
    transferLog,
    wireQuantity,
    WORLD_FIXTURE_ACCOUNTS,
    counterLog,
} from "./wire.mjs";
import {
    SCRIPTED_CHAIN_END_BLOCK,
    tailBlockIntervalSeconds as validateTailBlockInterval,
} from "./contract.mjs";

export const BASELINE_ADDRESSES = Object.freeze({
    nft: "0x1111111111111111111111111111111111111111",
    seller: WORLD_FIXTURE_ACCOUNTS.seller.address.toLowerCase(),
    buyer: WORLD_FIXTURE_ACCOUNTS.buyer.address.toLowerCase(),
    bidder: WORLD_FIXTURE_ACCOUNTS.bidder.address.toLowerCase(),
    weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    seaport: "0x0000000000000068f116a894984e2db1123eb395",
    conduitController: "0x5555555555555555555555555555555555555555",
});

/** External world state is a ledger of simulated chain facts, never DB rows. */
export function createBaselineLedger({
    epochSeconds = Math.floor(Date.now() / 1_000),
    maximumBlock = 140,
    addresses = {},
    transferOnly = false,
    tailBlockIntervalSeconds,
} = {}) {
    if (!Number.isSafeInteger(epochSeconds) || epochSeconds < 1)
        throw new Error("World requires a positive integer epochSeconds");
    if (!Number.isSafeInteger(maximumBlock) || maximumBlock < 107)
        throw new Error("World maximumBlock must be at least 107");
    const tailInterval = validateTailBlockInterval(tailBlockIntervalSeconds);
    const counterBlock = 105;
    const a = { ...BASELINE_ADDRESSES, ...addresses };
    const listing = prepareMarketOrder({
        addresses: a,
        nowSeconds: epochSeconds,
        side: "sell",
        tokenId: "1",
    });
    const bid = prepareMarketOrder({
        addresses: a,
        nowSeconds: epochSeconds,
        side: "buy",
        tokenId: "2",
    });
    const branches = new Map();
    const transactions = new Map();
    const receipts = new Map();
    for (const branch of ["A", "B"]) {
        const blocks = new Map();
        for (let number = 0; number <= maximumBlock; number++) {
            // Both branches share the exact prefix through the verified ancestor.
            const identity = number <= 103 ? "common" : branch;
            const parentIdentity = number - 1 <= 103 ? "common" : branch;
            const hash = hashIdentity(`artgod-world:${identity}:${number}`);
            const events = [];
            const txs = [];
            if (number === 101 || number === 102) {
                const tokenId = String(number - 100);
                events.push({ kind: "owner", tokenId, owner: a.seller });
                txs.push({
                    key: `mint:${tokenId}`,
                    from: a.seller,
                    to: a.nft,
                    logs: [
                        transferLog({
                            address: a.nft,
                            from: ZERO_ADDRESS,
                            to: a.seller,
                            tokenId,
                        }),
                    ],
                });
            }
            if (number === 102) {
                events.push(
                    {
                        kind: "operator",
                        owner: a.seller,
                        operator: a.seaport,
                        approved: true,
                    },
                    {
                        kind: "funding",
                        owner: a.bidder,
                        amount: 10_000_000_000_000_000_000n,
                    },
                    {
                        kind: "allowance",
                        owner: a.bidder,
                        spender: a.seaport,
                        amount: 10_000_000_000_000_000_000n,
                    },
                );
            }
            if (branch === "A" && number === 104) {
                events.push({ kind: "owner", tokenId: "1", owner: a.buyer });
                if (!transferOnly)
                    events.push({
                        kind: "status",
                        orderHash: listing.orderHash,
                        status: [true, false, 1n, 1n],
                    });
                txs.push({
                    key: transferOnly ? "transfer:1:A" : "sale:1:A",
                    from: a.buyer,
                    to: a.seaport,
                    logs: [
                        transferLog({
                            address: a.nft,
                            from: a.seller,
                            to: a.buyer,
                            tokenId: "1",
                        }),
                        ...(transferOnly ? [] : [fulfilledLog(listing, a)]),
                    ],
                });
            }
            if (branch === "A" && number === counterBlock) {
                // This genuine protocol event invalidates the bid independently
                // of source freshness or the periodically refreshed bidder index.
                events.push({ kind: "counter", owner: a.bidder, value: 1n });
                txs.push({
                    key: "counter:bidder:A",
                    from: a.bidder,
                    to: a.seaport,
                    logs: [counterLog(a.bidder, a.seaport, 1n)],
                });
            }
            const block = {
                branch: identity,
                number,
                hash,
                parentHash:
                    number === 0
                        ? ZERO_HASH
                        : hashIdentity(
                              `artgod-world:${parentIdentity}:${number - 1}`,
                          ),
                // Keep the authored fork window intact. Later empty canonical
                // blocks have a declared immutable cadence for fair recovery.
                timestamp:
                    epochSeconds +
                    Math.min(number, SCRIPTED_CHAIN_END_BLOCK) -
                    103 +
                    Math.max(0, number - SCRIPTED_CHAIN_END_BLOCK) *
                        tailInterval,
                events,
                transactions: [],
                logs: [],
            };
            for (const [index, tx] of txs.entries()) {
                const txHash = hashIdentity(`artgod-world:tx:${tx.key}`);
                const logs = tx.logs.map((log, logIndex) => ({
                    ...log,
                    blockNumber: wireQuantity(number),
                    blockHash: hash,
                    transactionHash: txHash,
                    transactionIndex: wireQuantity(index),
                    logIndex: wireQuantity(logIndex),
                    removed: false,
                }));
                const transaction = {
                    hash: txHash,
                    blockHash: hash,
                    blockNumber: wireQuantity(number),
                    transactionIndex: wireQuantity(index),
                    from: tx.from,
                    to: tx.to,
                    input: "0x",
                    value: "0x0",
                    nonce: "0x0",
                    gas: "0x100000",
                    gasPrice: "0x1",
                    type: "0x0",
                    chainId: "0x1",
                    v: "0x25",
                    r: `0x${"1".repeat(64)}`,
                    s: `0x${"2".repeat(64)}`,
                };
                transactions.set(txHash, transaction);
                receipts.set(txHash, {
                    transactionHash: txHash,
                    transactionIndex: wireQuantity(index),
                    blockHash: hash,
                    blockNumber: wireQuantity(number),
                    from: tx.from,
                    to: tx.to,
                    cumulativeGasUsed: "0x10000",
                    gasUsed: "0x10000",
                    effectiveGasPrice: "0x1",
                    contractAddress: null,
                    logs,
                    logsBloom: EMPTY_BLOOM,
                    status: "0x1",
                    type: "0x0",
                });
                block.transactions.push(txHash);
                block.logs.push(...logs);
            }
            blocks.set(number, block);
        }
        branches.set(branch, blocks);
    }

    function blockAt(branch, number) {
        const block = branches.get(branch)?.get(number);
        if (!block) throw new Error(`Unknown world block ${branch}:${number}`);
        return block;
    }

    function stateAt(branch, number) {
        blockAt(branch, number);
        const state = {
            owners: new Map(),
            operators: new Map(),
            funding: new Map(),
            allowances: new Map(),
            statuses: new Map(),
            counters: new Map(),
        };
        for (let n = 0; n <= number; n++) {
            for (const event of blockAt(branch, n).events) {
                switch (event.kind) {
                    case "owner":
                        state.owners.set(event.tokenId, event.owner);
                        break;
                    case "operator":
                        state.operators.set(
                            `${event.owner}:${event.operator}`,
                            event.approved,
                        );
                        break;
                    case "funding":
                        state.funding.set(event.owner, event.amount);
                        break;
                    case "allowance":
                        state.allowances.set(
                            `${event.owner}:${event.spender}`,
                            event.amount,
                        );
                        break;
                    case "status":
                        state.statuses.set(event.orderHash, event.status);
                        break;
                    case "counter":
                        state.counters.set(event.owner, event.value);
                        break;
                    default:
                        throw new Error(`Unknown ledger event ${event.kind}`);
                }
            }
        }
        return state;
    }

    return {
        addresses: a,
        epochSeconds,
        maximumBlock,
        tailBlockIntervalSeconds: tailInterval,
        chainId: 1,
        collectionSlug: "simulation-two-tokens",
        anchorBlock: 100,
        initialHead: 103,
        forkBlock: 103,
        counterBlock,
        orders: { listing, bid },
        branches,
        transactions,
        receipts,
        blockAt,
        stateAt,
    };
}

export function blockToWire(block, includeTransactions, transactions) {
    return {
        number: wireQuantity(block.number),
        hash: block.hash,
        parentHash: block.parentHash,
        timestamp: wireQuantity(block.timestamp),
        transactions: includeTransactions
            ? block.transactions.map((hash) => transactions.get(hash))
            : block.transactions,
        nonce: "0x0000000000000000",
        sha3Uncles: ZERO_HASH,
        logsBloom: EMPTY_BLOOM,
        transactionsRoot: ZERO_HASH,
        stateRoot: ZERO_HASH,
        receiptsRoot: ZERO_HASH,
        miner: ZERO_ADDRESS,
        difficulty: "0x0",
        totalDifficulty: "0x0",
        extraData: "0x",
        size: "0x100",
        gasLimit: "0x1c9c380",
        gasUsed: "0x10000",
        baseFeePerGas: "0x1",
        uncles: [],
        mixHash: ZERO_HASH,
    };
}
