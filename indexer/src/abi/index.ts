import { parseAbi } from "viem";

// Protocol event names keep log filters and decoders aligned.
export const ERC721_EVENT_NAME = {
    Transfer: "Transfer",
    Approval: "Approval",
    ApprovalForAll: "ApprovalForAll",
} as const;

export const ERC1155_EVENT_NAME = {
    TransferSingle: "TransferSingle",
    TransferBatch: "TransferBatch",
} as const;

export const ERC721_ABI = [
    {
        type: "event",
        name: ERC721_EVENT_NAME.Transfer,
        inputs: [
            { indexed: true, name: "from", type: "address" },
            { indexed: true, name: "to", type: "address" },
            { indexed: true, name: "tokenId", type: "uint256" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: ERC721_EVENT_NAME.Approval,
        inputs: [
            { indexed: true, name: "owner", type: "address" },
            { indexed: true, name: "approved", type: "address" },
            { indexed: true, name: "tokenId", type: "uint256" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: ERC721_EVENT_NAME.ApprovalForAll,
        inputs: [
            { indexed: true, name: "owner", type: "address" },
            { indexed: true, name: "operator", type: "address" },
            { indexed: false, name: "approved", type: "bool" },
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
        name: ERC1155_EVENT_NAME.TransferSingle,
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
        name: ERC1155_EVENT_NAME.TransferBatch,
        inputs: [
            { indexed: true, name: "operator", type: "address" },
            { indexed: true, name: "from", type: "address" },
            { indexed: true, name: "to", type: "address" },
            { indexed: false, name: "ids", type: "uint256[]" },
            { indexed: false, name: "values", type: "uint256[]" },
        ],
        anonymous: false,
    },
    {
        type: "event",
        name: "ApprovalForAll",
        inputs: [
            { indexed: true, name: "account", type: "address" },
            { indexed: true, name: "operator", type: "address" },
            { indexed: false, name: "approved", type: "bool" },
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

// NFT call ABIs are shared by receipt-aware protocol decoders.
export const NFT_TRANSFER_FUNCTION_NAME = {
    TransferFrom: "transferFrom",
    SafeTransferFrom: "safeTransferFrom",
    SafeBatchTransferFrom: "safeBatchTransferFrom",
} as const;
export const ERC721_TRANSFER_ABI = parseAbi([
    `function ${NFT_TRANSFER_FUNCTION_NAME.TransferFrom}(address from, address to, uint256 tokenId)`,
    `function ${NFT_TRANSFER_FUNCTION_NAME.SafeTransferFrom}(address from, address to, uint256 tokenId)`,
    `function ${NFT_TRANSFER_FUNCTION_NAME.SafeTransferFrom}(address from, address to, uint256 tokenId, bytes data)`,
]);
export const ERC1155_TRANSFER_ABI = parseAbi([
    `function ${NFT_TRANSFER_FUNCTION_NAME.SafeTransferFrom}(address from, address to, uint256 id, uint256 amount, bytes data)`,
    `function ${NFT_TRANSFER_FUNCTION_NAME.SafeBatchTransferFrom}(address from, address to, uint256[] ids, uint256[] amounts, bytes data)`,
]);
