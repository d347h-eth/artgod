// ArtGod-owned mainnet pins used to validate OpenSea wallet authority independently of the SDK.
export const OPENSEA_MAINNET_SECURITY_POLICY = {
    chainId: 1,
    seaportName: "Seaport",
    seaportVersion: "1.6",
    seaportAddress: "0x0000000000000068F116a894984e2DB1123eB395",
    signedZoneAddress: "0x000056f7000000ece9003ca63978907a00ffd100",
    conduitKey:
        "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
    conduitAddress: "0x1e0049783f008a0085193e00003d00cd54003c71",
    wethAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    zeroAddress: "0x0000000000000000000000000000000000000000",
    zeroBytes32:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
} as const;
