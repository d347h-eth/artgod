// Names EVM proxy bytecode families recognized by ArtGod adapters.
export const EVM_PROXY_KIND = {
    Eip1167Minimal: "eip1167_minimal",
} as const;

// Union of proxy bytecode families recognized by shared EVM helpers.
export type EvmProxyKind = (typeof EVM_PROXY_KIND)[keyof typeof EVM_PROXY_KIND];

// Minimal proxy identity exposed by probe/read adapters after bytecode detection.
export type EvmProxyResolution = {
    kind: EvmProxyKind;
    implementationAddress: `0x${string}`;
};

// EIP-1167 runtime bytecode before the embedded 20-byte implementation address.
const EIP1167_MINIMAL_PROXY_RUNTIME_PREFIX = "363d3d373d3d3d363d73";
// EIP-1167 runtime bytecode after the embedded 20-byte implementation address.
const EIP1167_MINIMAL_PROXY_RUNTIME_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
const EVM_ADDRESS_HEX_LENGTH = 40;

// Detects known proxy runtime bytecode and extracts the implementation address.
export function detectEvmProxy(
    bytecode: `0x${string}` | string | null | undefined,
): EvmProxyResolution | null {
    const normalized = normalizeHexBytecode(bytecode);
    if (!normalized) return null;

    const eip1167 = detectEip1167MinimalProxy(normalized);
    if (eip1167) return eip1167;

    return null;
}

function detectEip1167MinimalProxy(bytecode: string): EvmProxyResolution | null {
    if (
        !bytecode.startsWith(EIP1167_MINIMAL_PROXY_RUNTIME_PREFIX) ||
        !bytecode.endsWith(EIP1167_MINIMAL_PROXY_RUNTIME_SUFFIX)
    ) {
        return null;
    }

    const implementation = bytecode.slice(
        EIP1167_MINIMAL_PROXY_RUNTIME_PREFIX.length,
        bytecode.length - EIP1167_MINIMAL_PROXY_RUNTIME_SUFFIX.length,
    );
    if (!isAddressHex(implementation)) return null;

    return {
        kind: EVM_PROXY_KIND.Eip1167Minimal,
        implementationAddress: `0x${implementation}`,
    };
}

function normalizeHexBytecode(
    bytecode: `0x${string}` | string | null | undefined,
): string | null {
    if (typeof bytecode !== "string") return null;
    const trimmed = bytecode.trim().toLowerCase();
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    return hex.length > 0 && /^[a-f0-9]+$/.test(hex) ? hex : null;
}

function isAddressHex(value: string): boolean {
    return value.length === EVM_ADDRESS_HEX_LENGTH && /^[a-f0-9]+$/.test(value);
}
