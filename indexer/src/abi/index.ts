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

export const ERC721_ENUMERABLE_ABI = [
    {
        type: "function",
        name: "totalSupply",
        inputs: [],
        outputs: [{ name: "totalSupply", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "tokenByIndex",
        inputs: [{ name: "index", type: "uint256" }],
        outputs: [{ name: "tokenId", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "ownerOf",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "owner", type: "address" }],
        stateMutability: "view",
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

export const ERC721_APPROVAL_ABI = [
    {
        type: "function",
        name: "ownerOf",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "owner", type: "address" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getApproved",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [{ name: "operator", type: "address" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "isApprovedForAll",
        inputs: [
            { name: "owner", type: "address" },
            { name: "operator", type: "address" },
        ],
        outputs: [{ name: "approved", type: "bool" }],
        stateMutability: "view",
    },
] as const;

export const ERC4906_ABI = [
    {
        type: "event",
        name: "MetadataUpdate",
        inputs: [{ indexed: false, name: "tokenId", type: "uint256" }],
        anonymous: false,
    },
    {
        type: "event",
        name: "BatchMetadataUpdate",
        inputs: [
            { indexed: false, name: "fromTokenId", type: "uint256" },
            { indexed: false, name: "toTokenId", type: "uint256" },
        ],
        anonymous: false,
    },
] as const;

export const ERC20_ABI = [
    {
        type: "function",
        name: "balanceOf",
        inputs: [{ name: "owner", type: "address" }],
        outputs: [{ name: "balance", type: "uint256" }],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "allowance",
        inputs: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
        ],
        outputs: [{ name: "allowance", type: "uint256" }],
        stateMutability: "view",
    },
] as const;
