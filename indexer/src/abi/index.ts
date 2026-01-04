export const ERC721_ABI = [
    {
        type: "event",
        name: "Transfer",
        inputs: [
            { indexed: true, name: "from", type: "address" },
            { indexed: true, name: "to", type: "address" },
            { indexed: true, name: "tokenId", type: "uint256" },
        ],
        anonymous: false,
    },
] as const;

export const ERC1155_ABI = [
    {
        type: "event",
        name: "TransferSingle",
        inputs: [
            { indexed: true, name: "operator", type: "address" },
            { indexed: true, name: "from", type: "address" },
            { indexed: true, name: "to", type: "address" },
            { indexed: false, name: "id", type: "uint256" },
            { indexed: false, name: "value", type: "uint256" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "TransferBatch",
        inputs: [
            { indexed: true, name: "operator", type: "address" },
            { indexed: true, name: "from", type: "address" },
            { indexed: true, name: "to", type: "address" },
            { indexed: false, name: "ids", type: "uint256[]" },
            { indexed: false, name: "values", type: "uint256[]" },
        ],
        anonymous: false,
    },
] as const;
