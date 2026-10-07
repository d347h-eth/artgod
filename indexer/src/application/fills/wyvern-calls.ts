import {
    decodeAbiParameters,
    decodeFunctionData,
    encodeFunctionData,
    zeroAddress,
} from "viem";
import { FILL_ITEM_TYPE } from "@artgod/shared/market-data/fills";
import { ORDER_SIDE, type OrderSide } from "@artgod/shared/market-data/orders";
import {
    ERC1155_TRANSFER_ABI,
    ERC721_TRANSFER_ABI,
    NFT_TRANSFER_FUNCTION_NAME,
} from "../../abi/index.js";
import type { EnhancedTransaction } from "../../domain/onchain.js";
import type { Hex } from "../../ports/rpc.js";
import { decodePackedWyvernCalls } from "./wyvern-packed.js";
import {
    WYVERN_ATOMICIZER_ABI,
    WYVERN_CALL_TYPE,
    WYVERN_EXCHANGE_ABI,
    WYVERN_EXCHANGE_ADDRESSES,
    WYVERN_FUNCTION_NAME,
    WYVERN_MERKLE_VALIDATOR_ABI,
    WYVERN_NFT_FUNCTION_NAME,
    WYVERN_NFT_TARGET_ADDRESS,
    WYVERN_ORDER_SIDE,
    WYVERN_ROUTER_ABI,
    WYVERN_ROUTER_ADDRESS,
    WYVERN_ROUTER_FUNCTION_NAME,
    WYVERN_ARGENT_ABI,
    WYVERN_ROUTER_MARKET,
    WYVERN_GENIE_MARKET_ABI,
    WYVERN_EXCHANGE_ADDRESS,
    WYVERN_GENIE_BUY_SELECTOR,
} from "./wyvern-abi.js";

export type WyvernNftCall = {
    contract: string;
    identifier: string;
    amount: string;
    itemType: number;
    from: string;
    to: string;
};
export type WyvernMatchCall = {
    protocolAddress: string;
    maker: string;
    taker: string;
    seller: string;
    currency: string;
    orderSide: OrderSide;
    metadata: string;
    nfts: readonly WyvernNftCall[];
};

const MAX_CALL_DEPTH = 8;

/** Only unwrap ABI-defined calls through known implementations. The receipt
 * must still establish that a candidate's complete NFT call actually executed. */
export function decodeWyvernMatchCalls(
    transaction: EnhancedTransaction["transaction"],
): WyvernMatchCall[] {
    return [
        ...unwrapCalls(transaction.to, transaction.input, 0),
        ...decodePackedWyvernCalls(transaction),
    ];
}

function unwrapCalls(
    to: string | null,
    input: Hex,
    depth: number,
): WyvernMatchCall[] {
    if (!to || depth >= MAX_CALL_DEPTH) return [];
    const target = to.toLowerCase();
    try {
        if (WYVERN_EXCHANGE_ADDRESSES.has(target)) {
            const call = decodeAtomicMatch(target, input);
            return call ? [call] : [];
        }
        if (target === WYVERN_ROUTER_ADDRESS.ArgentModule) {
            const { functionName, args } = decodeFunctionData({
                abi: WYVERN_ARGENT_ABI,
                data: input,
            });
            if (functionName === WYVERN_ROUTER_FUNCTION_NAME.Execute) {
                const inner = decodeFunctionData({
                    abi: WYVERN_ARGENT_ABI,
                    data: args[1],
                });
                if (
                    inner.functionName ===
                        WYVERN_ROUTER_FUNCTION_NAME.Execute ||
                    inner.args[0].toLowerCase() !== args[0].toLowerCase()
                )
                    return [];
                return inner.args[1].flatMap((call) =>
                    unwrapCalls(call.to, call.data, depth + 1),
                );
            }
            return args[1].flatMap((call) =>
                unwrapCalls(call.to, call.data, depth + 1),
            );
        }
        if (
            target !== WYVERN_ROUTER_ADDRESS.Gem &&
            target !== WYVERN_ROUTER_ADDRESS.Genie
        )
            return [];
        const { functionName, args } = decodeFunctionData({
            abi: WYVERN_ROUTER_ABI,
            data: input,
        });
        let trades: readonly { tradeData: Hex; marketId?: bigint }[];
        switch (functionName) {
            case WYVERN_ROUTER_FUNCTION_NAME.BatchBuyWithEth:
            case WYVERN_ROUTER_FUNCTION_NAME.BatchBuyFromOpenSea:
                trades = args[0];
                break;
            case WYVERN_ROUTER_FUNCTION_NAME.BatchBuyWithErc20s:
                trades = args[1];
                break;
            case WYVERN_ROUTER_FUNCTION_NAME.MultiAssetSwap:
                trades = args[4];
                break;
        }
        // Exchange identity is part of atomicMatch_ itself and is checked below.
        return trades.flatMap((trade) => {
            if (
                target === WYVERN_ROUTER_ADDRESS.Genie &&
                trade.marketId === WYVERN_ROUTER_MARKET.GenieV22
            ) {
                return decodeGenieBuys(trade.tradeData);
            }
            if (
                target === WYVERN_ROUTER_ADDRESS.Gem &&
                functionName === WYVERN_ROUTER_FUNCTION_NAME.BatchBuyFromOpenSea
            ) {
                const call = decodeAtomicMatch(
                    WYVERN_EXCHANGE_ADDRESS.V22,
                    trade.tradeData,
                );
                return call ? [call] : [];
            }
            if (
                target !== WYVERN_ROUTER_ADDRESS.Gem ||
                (trade.marketId !== undefined &&
                    trade.marketId !== WYVERN_ROUTER_MARKET.GemV23)
            )
                return [];
            const call = decodeAtomicMatch(
                WYVERN_EXCHANGE_ADDRESS.V23,
                trade.tradeData,
            );
            return call ? [call] : [];
        });
    } catch {
        return [];
    }
}

function decodeGenieBuys(data: Hex): WyvernMatchCall[] {
    try {
        if (data.slice(0, 10) !== WYVERN_GENIE_BUY_SELECTOR) return [];
        const args = decodeAbiParameters(
            WYVERN_GENIE_MARKET_ABI[0].inputs,
            ("0x" + data.slice(10)) as Hex,
        );
        return args[0].flatMap((buy) => {
            const input = encodeFunctionData({
                abi: WYVERN_EXCHANGE_ABI,
                functionName: WYVERN_FUNCTION_NAME.AtomicMatch,
                args: [
                    buy.addrs,
                    buy.uints,
                    buy.feeMethodsSidesKindsHowToCalls,
                    buy.calldataBuy,
                    buy.calldataSell,
                    buy.replacementPatternBuy,
                    buy.replacementPatternSell,
                    buy.staticExtradataBuy,
                    buy.staticExtradataSell,
                    buy.vs,
                    buy.rssMetadata,
                ],
            });
            const call = decodeAtomicMatch(WYVERN_EXCHANGE_ADDRESS.V22, input);
            return call ? [call] : [];
        });
    } catch {
        return [];
    }
}

function decodeAtomicMatch(
    destination: string | null,
    input: Hex,
): WyvernMatchCall | null {
    try {
        const { functionName, args } = decodeFunctionData({
            abi: WYVERN_EXCHANGE_ABI,
            data: input,
        });
        if (functionName !== WYVERN_FUNCTION_NAME.AtomicMatch) return null;
        const [
            rawAddresses,
            ,
            flags,
            buyData,
            sellData,
            buyMask,
            sellMask,
            ,
            ,
            ,
            hashes,
        ] = args;
        const addresses = rawAddresses.map((address) => address.toLowerCase());
        const protocolAddress = addresses[0]!;
        const currency = addresses[6]!;
        if (
            !WYVERN_EXCHANGE_ADDRESSES.has(protocolAddress) ||
            (destination !== null && destination !== protocolAddress) ||
            protocolAddress !== addresses[7] ||
            currency !== addresses[13] ||
            addresses[4] !== addresses[11] ||
            flags[1] !== WYVERN_ORDER_SIDE.Buy ||
            flags[5] !== WYVERN_ORDER_SIDE.Sell ||
            flags[0] !== flags[4] ||
            flags[3] !== flags[7] ||
            (addresses[3] === zeroAddress) === (addresses[10] === zeroAddress)
        )
            return null;
        // Wyvern applies the buy replacement first, then uses that result to
        // replace the sell payload. Independent replacement gives wrong IDs.
        const matchedBuy = guardedReplace(buyData, sellData, buyMask);
        if (matchedBuy === null) return null;
        const matchedSell = guardedReplace(sellData, matchedBuy, sellMask);
        if (matchedSell === null || matchedSell !== matchedBuy) return null;
        const decodedNfts = decodeNftCalls(
            addresses[4]!,
            matchedSell,
            flags[3],
            0,
        );
        const seller = addresses[8]!;
        // Keep opaque call identities so another attempted call with the same
        // maker/taker cannot lend them a partial NFT context or wrong currency.
        const nfts =
            decodedNfts && decodedNfts.every((nft) => nft.from === seller)
                ? decodedNfts
                : [];
        const isAsk = addresses[10] !== zeroAddress;
        return {
            protocolAddress,
            currency,
            seller,
            nfts,
            maker: isAsk ? seller : addresses[1]!,
            taker: isAsk ? addresses[1]! : seller,
            orderSide: isAsk ? ORDER_SIDE.Sell : ORDER_SIDE.Buy,
            metadata: hashes[4].toLowerCase(),
        };
    } catch {
        return null;
    }
}

function guardedReplace(
    original: Hex,
    replacement: Hex,
    mask: Hex,
): Hex | null {
    if (mask === "0x") return original.toLowerCase() as Hex;
    if (
        original.length !== replacement.length ||
        original.length !== mask.length
    )
        return null;
    let result = "0x";
    for (let i = 2; i < original.length; i += 2) {
        const bits = Number.parseInt(mask.slice(i, i + 2), 16);
        const value =
            (Number.parseInt(original.slice(i, i + 2), 16) & (255 ^ bits)) |
            (Number.parseInt(replacement.slice(i, i + 2), 16) & bits);
        result += value.toString(16).padStart(2, "0");
    }
    return result as Hex;
}

function decodeNftCalls(
    target: string,
    data: Hex,
    howToCall: number,
    depth: number,
): WyvernNftCall[] | null {
    if (depth >= MAX_CALL_DEPTH) return null;
    try {
        if (
            target === WYVERN_NFT_TARGET_ADDRESS.Atomicizer &&
            howToCall === WYVERN_CALL_TYPE.DelegateCall
        ) {
            const { args } = decodeFunctionData({
                abi: WYVERN_ATOMICIZER_ABI,
                data,
            });
            const [targets, values, lengths, payload] = args;
            if (
                targets.length !== values.length ||
                targets.length !== lengths.length ||
                values.some((value) => value !== 0n)
            )
                return null;
            let offset = 2;
            const nfts: WyvernNftCall[] = [];
            for (let i = 0; i < targets.length; i++) {
                const length = lengths[i]!;
                if (length > BigInt((payload.length - offset) / 2)) return null;
                const end = offset + Number(length) * 2;
                const child = decodeNftCalls(
                    targets[i]!.toLowerCase(),
                    ("0x" + payload.slice(offset, end)) as Hex,
                    WYVERN_CALL_TYPE.Call,
                    depth + 1,
                );
                // An unknown leaf could contain another NFT. Never price a
                // partly interpreted bundle using only its recognized items.
                if (!child?.length) return null;
                nfts.push(...child);
                offset = end;
            }
            return offset === payload.length ? nfts : null;
        }
        if (
            target === WYVERN_NFT_TARGET_ADDRESS.MerkleValidator &&
            howToCall === WYVERN_CALL_TYPE.DelegateCall
        ) {
            const { functionName, args } = decodeFunctionData({
                abi: WYVERN_MERKLE_VALIDATOR_ABI,
                data,
            });
            return [
                nftCall(
                    args[2],
                    args[0],
                    args[1],
                    args[3],
                    functionName === WYVERN_NFT_FUNCTION_NAME.MatchErc1155
                        ? args[4]
                        : 1n,
                    functionName === WYVERN_NFT_FUNCTION_NAME.MatchErc1155
                        ? FILL_ITEM_TYPE.Erc1155
                        : FILL_ITEM_TYPE.Erc721,
                ),
            ];
        }
        if (howToCall !== WYVERN_CALL_TYPE.Call) return null;
        try {
            const { args } = decodeFunctionData({
                abi: ERC721_TRANSFER_ABI,
                data,
            });
            return [
                nftCall(
                    target,
                    args[0],
                    args[1],
                    args[2],
                    1n,
                    FILL_ITEM_TYPE.Erc721,
                ),
            ];
        } catch {
            const { functionName, args } = decodeFunctionData({
                abi: ERC1155_TRANSFER_ABI,
                data,
            });
            if (functionName === NFT_TRANSFER_FUNCTION_NAME.SafeTransferFrom)
                return [
                    nftCall(
                        target,
                        args[0],
                        args[1],
                        args[2],
                        args[3],
                        FILL_ITEM_TYPE.Erc1155,
                    ),
                ];
            if (args[2].length !== args[3].length) return null;
            return args[2].map((id, i) =>
                nftCall(
                    target,
                    args[0],
                    args[1],
                    id,
                    args[3][i]!,
                    FILL_ITEM_TYPE.Erc1155,
                ),
            );
        }
    } catch {
        return null;
    }
}

function nftCall(
    contract: string,
    from: string,
    to: string,
    identifier: bigint,
    amount: bigint,
    itemType: number,
): WyvernNftCall {
    if (
        amount <= 0n ||
        from.toLowerCase() === zeroAddress ||
        to.toLowerCase() === zeroAddress
    )
        throw new Error("Invalid Wyvern NFT transfer");
    return {
        contract: contract.toLowerCase(),
        from: from.toLowerCase(),
        to: to.toLowerCase(),
        identifier: identifier.toString(),
        amount: amount.toString(),
        itemType,
    };
}
