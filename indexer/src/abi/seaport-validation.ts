/** Seaport views used by both individual and aggregated order validation. */
export const SEAPORT_VALIDATION_ABI = [
    {
        type: "function",
        name: "getOrderStatus",
        inputs: [{ name: "orderHash", type: "bytes32" }],
        outputs: [
            { name: "isValidated", type: "bool" },
            { name: "isCancelled", type: "bool" },
            { name: "totalFilled", type: "uint256" },
            { name: "totalSize", type: "uint256" },
        ],
        stateMutability: "view",
    },
    {
        type: "function",
        name: "getCounter",
        inputs: [{ name: "offerer", type: "address" }],
        outputs: [{ name: "counter", type: "uint256" }],
        stateMutability: "view",
    },
] as const;
