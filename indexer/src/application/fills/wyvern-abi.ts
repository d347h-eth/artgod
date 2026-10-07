import { parseAbi, toFunctionSelector } from "viem";

// Verified exchange deployments linked by OpenSea's Wyvern 2.3 upgrade guide.
export const WYVERN_EXCHANGE_ADDRESS = {
    V22: "0x7be8076f4ea4a4ad08075c2508e481d6c946d12b",
    V23: "0x7f268357a8c2552623316e2562d90e642bb538e5",
} as const;
export const WYVERN_EXCHANGE_ADDRESSES = new Set<string>(
    Object.values(WYVERN_EXCHANGE_ADDRESS),
);
export const WYVERN_EVENT_NAME = { OrdersMatched: "OrdersMatched" } as const;
export const WYVERN_FUNCTION_NAME = { AtomicMatch: "atomicMatch_" } as const;
export const WYVERN_CALL_TYPE = { Call: 0, DelegateCall: 1 } as const;
export const WYVERN_ORDER_SIDE = { Buy: 0, Sell: 1 } as const;

// Both versions share these signatures. Gross price comes from the event,
// while currency and the executed NFT payload come from the matched orders.
// https://github.com/ProjectWyvern/wyvern-ethereum/blob/master/contracts/exchange/ExchangeCore.sol
export const WYVERN_EXCHANGE_ABI = parseAbi([
    `event ${WYVERN_EVENT_NAME.OrdersMatched}(bytes32 buyHash, bytes32 sellHash, address indexed maker, address indexed taker, uint256 price, bytes32 indexed metadata)`,
    `function ${WYVERN_FUNCTION_NAME.AtomicMatch}(address[14] addrs, uint256[18] uints, uint8[8] feeMethodsSidesKindsHowToCalls, bytes calldataBuy, bytes calldataSell, bytes replacementPatternBuy, bytes replacementPatternSell, bytes staticExtradataBuy, bytes staticExtradataSell, uint8[2] vs, bytes32[5] rssMetadata) payable`,
]);

export const WYVERN_NFT_TARGET_ADDRESS = {
    Atomicizer: "0xc99f70bfd82fb7c8f8191fdfbfb735606b15e5c5",
    MerkleValidator: "0xbaf2127b49fc93cbca6269fade0f7f31df4c88a7",
} as const;
export const WYVERN_NFT_FUNCTION_NAME = {
    Atomicize: "atomicize",
    MatchErc721: "matchERC721UsingCriteria",
    MatchSafeErc721: "matchERC721WithSafeTransferUsingCriteria",
    MatchErc1155: "matchERC1155UsingCriteria",
} as const;
export const WYVERN_ATOMICIZER_ABI = parseAbi([
    `function ${WYVERN_NFT_FUNCTION_NAME.Atomicize}(address[] addrs, uint256[] values, uint256[] calldataLengths, bytes calldatas)`,
]);
export const WYVERN_MERKLE_VALIDATOR_ABI = parseAbi([
    `function ${WYVERN_NFT_FUNCTION_NAME.MatchErc721}(address from, address to, address token, uint256 tokenId, bytes32 root, bytes32[] proof) returns (bool)`,
    `function ${WYVERN_NFT_FUNCTION_NAME.MatchSafeErc721}(address from, address to, address token, uint256 tokenId, bytes32 root, bytes32[] proof) returns (bool)`,
    `function ${WYVERN_NFT_FUNCTION_NAME.MatchErc1155}(address from, address to, address token, uint256 tokenId, uint256 amount, bytes32 root, bytes32[] proof) returns (bool)`,
]);

export const WYVERN_ROUTER_ADDRESS = {
    Genie: "0x0a267cf51ef038fc00e71801f5a524aec06e4f07",
    Gem: "0x83c8f28c26bf6aaca652df1dbbe0e1b56f8baba2",
    ArgentModule: "0x9d58779365b067d5d3fcc6e92d237acd06f1e6a1",
} as const;
export const WYVERN_ROUTER_FUNCTION_NAME = {
    BatchBuyWithEth: "batchBuyWithETH",
    BatchBuyWithErc20s: "batchBuyWithERC20s",
    BatchBuyFromOpenSea: "batchBuyFromOpenSea",
    MultiAssetSwap: "multiAssetSwap",
    Execute: "execute",
    BuyAssetsForEth: "buyAssetsForEth",
    MultiCall: "multiCall",
    MultiCallWithGuardians: "multiCallWithGuardians",
} as const;
export const WYVERN_ROUTER_MARKET = { GenieV22: 3n, GemV23: 10n } as const;
const trade = "(uint256 marketId, uint256 value, bytes tradeData)[]";
const erc20 = "(address[] tokenAddrs, uint256[] amounts)";
const conversion = "(bytes conversionData)[]";
// The verified Genie/Gem source exposes these nested trade payloads. Do not
// search arbitrary transaction bytes for a selector or payment address.
export const WYVERN_ROUTER_ABI = parseAbi([
    `function ${WYVERN_ROUTER_FUNCTION_NAME.BatchBuyWithEth}(${trade} tradeDetails) payable`,
    `function ${WYVERN_ROUTER_FUNCTION_NAME.BatchBuyWithErc20s}(${erc20} erc20Details, ${trade} tradeDetails, ${conversion} conversionDetails, address[] dustTokens) payable`,
    `function ${WYVERN_ROUTER_FUNCTION_NAME.BatchBuyFromOpenSea}((uint256 value, bytes tradeData)[] openseaTrades) payable`,
    `function ${WYVERN_ROUTER_FUNCTION_NAME.MultiAssetSwap}(${erc20} erc20Details, (address tokenAddr, address[] to, uint256[] ids)[] erc721Details, (address tokenAddr, uint256[] ids, uint256[] amounts)[] erc1155Details, ${conversion} conversionDetails, ${trade} tradeDetails, address[] dustTokens, uint256[2] feeDetails) payable`,
]);
// Verified ArgentModule relays its own encoded multicall and asks the wallet
// to invoke each destination. The outer execute's first address is the wallet.
export const WYVERN_ARGENT_ABI = parseAbi([
    `function ${WYVERN_ROUTER_FUNCTION_NAME.Execute}(address wallet, bytes data, uint256 nonce, bytes signatures, uint256 gasPrice, uint256 gasLimit, address refundToken, address refundAddress) returns (bool)`,
    `function ${WYVERN_ROUTER_FUNCTION_NAME.MultiCall}(address wallet, (address to, uint256 value, bytes data)[] transactions) returns (bytes[])`,
    `function ${WYVERN_ROUTER_FUNCTION_NAME.MultiCallWithGuardians}(address wallet, (address to, uint256 value, bytes data)[] transactions) returns (bytes[])`,
]);

// Verified OpenSeaMarket library used by Genie market 3 in the January sample:
// https://etherscan.io/address/0xa8b5272984d986d03c5144a70647000bbc613d39#code
// This payload is a tuple batch, rather than an embedded atomicMatch_ selector.
export const WYVERN_GENIE_MARKET_ABI = parseAbi([
    `function ${WYVERN_ROUTER_FUNCTION_NAME.BuyAssetsForEth}((address[14] addrs, uint256[18] uints, uint8[8] feeMethodsSidesKindsHowToCalls, bytes calldataBuy, bytes calldataSell, bytes replacementPatternBuy, bytes replacementPatternSell, bytes staticExtradataBuy, bytes staticExtradataSell, uint8[2] vs, bytes32[5] rssMetadata)[] openSeaBuys, bool revertIfTrxFails)`,
]);
// Solidity library selectors use the qualified struct name, although the
// argument encoding is the ordinary tuple-array ABI encoding.
export const WYVERN_GENIE_BUY_SELECTOR = toFunctionSelector(
    `${WYVERN_ROUTER_FUNCTION_NAME.BuyAssetsForEth}(OpenSeaMarket.OpenSeaBuy[],bool)`,
);
