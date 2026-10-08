# Wyvern sale fixtures

Public Ethereum transactions and complete receipts selected from the Terraforms
OpenSea sale feed for 15–21 January and 15–21 March 2022. The selection spans
Wyvern 2.2/2.3, accepted WETH offers, native ETH purchases, criteria transfers,
one genuine two-NFT bundle, Gem, Genie, ArgentModule and packed helper calls.

`expected-sales.json` keeps API unit prices and payment addresses alongside
receipt execution totals, settlement currency and NFT transfer endpoints. Its
`apiBuyer` field is retained for comparison: routed API events can name the router, while `buyer`
names the actual NFT recipient. The production decoder uses no marketplace API
data or collection-specific rule.

`apiCurrency` retains the feed payment address; `currency` is the verified
Wyvern settlement address. The Gem fixture routes ERC20 funding through WETH
and settles its Wyvern purchase in native ETH. Outer funding does not change
that fact.

Protocol ABI/source references:

- [Wyvern exchange source](https://github.com/ProjectWyvern/wyvern-ethereum/blob/master/contracts/exchange/ExchangeCore.sol)
- [OpenSea exchange upgrade guide](https://opensea.io/blog/articles/wyvern-2-3-developer-upgrade-guide)
- [MerkleValidator](https://etherscan.io/address/0xbaf2127b49fc93cbca6269fade0f7f31df4c88a7#code)
- [Genie](https://etherscan.io/address/0x0a267cf51ef038fc00e71801f5a524aec06e4f07#code)
- [Genie OpenSeaMarket library](https://etherscan.io/address/0xa8b5272984d986d03c5144a70647000bbc613d39#code)
- [Gem](https://etherscan.io/address/0x83c8f28c26bf6aaca652df1dbbe0e1b56f8baba2#code)
- [ArgentModule](https://etherscan.io/address/0x9d58779365b067d5d3fcc6e92d237acd06f1e6a1#code)

## Packed helper evidence

The two `bytecode-*.json` files contain historical `eth_getCode` responses, with
their public address and block. These contracts have no verified Solidity
source. Their small bytecode programs build `atomicMatch_` calldata directly;
the format was checked by reconstructing each exchange call locally and
comparing its decoded parameters to successful execution/transfer logs.
This requires no transaction traces.

Both programs:

- write the known exchange and their own address as exchange/buyer;
- leave both payment-token words zero and never copy input into those words;
- construct sell-side matches with one ERC721 item per exchange call;
- put `CALLER` in the NFT recipient field;
- leave execution metadata zero;
- place the NFT collection in the first 20 input bytes.

Offsets below are bytes from the start of input, without a function selector.

| Helper                                       | Shape                                              | Seller address           | NFT identifier            |
| -------------------------------------------- | -------------------------------------------------- | ------------------------ | ------------------------- |
| `0x00000000efaf2854f5b7975efe87edbfacd80b12` | 199 bytes, one Wyvern 2.2 match                    | bytes 22–41              | bytes 103–134             |
| `0x0000000035634b55f3d99b071b5a354f48e10bef` | 22-byte header plus 168 bytes per Wyvern 2.3 match | 20 bytes at `26 + 168*i` | 32 bytes at `111 + 168*i` |

The first helper uses the collection's ERC721 `transferFrom`; the second uses
the known criteria validator's ERC721 call. Native ETH follows from the
constructed payment-token fields, rather than missing ERC20 events or outer
transaction value. The decoder requires the exact known format and matches
each attempted purchase to a successful receipt execution and NFT transfer.
