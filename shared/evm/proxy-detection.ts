// Names EVM proxy families recognized by ArtGod adapters.
export const EVM_PROXY_KIND = {
    Eip1167Minimal: "eip1167_minimal",
    Erc1967Implementation: "erc1967_implementation",
    Erc1967Beacon: "erc1967_beacon",
} as const;

// Union of proxy families recognized by shared EVM helpers.
export type EvmProxyKind = (typeof EVM_PROXY_KIND)[keyof typeof EVM_PROXY_KIND];

// Confidence labels for proxy detections surfaced across API boundaries.
export const EVM_PROXY_CONFIDENCE = {
    Deterministic: "deterministic",
} as const;

// Union of proxy confidence labels recognized by shared EVM helpers.
export type EvmProxyConfidence =
    (typeof EVM_PROXY_CONFIDENCE)[keyof typeof EVM_PROXY_CONFIDENCE];

// ERC-1967 storage slots used by transparent, UUPS, and beacon proxy families.
export const EVM_PROXY_STORAGE_SLOT = {
    Erc1967Implementation:
        "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
    Erc1967Beacon:
        "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;

// Proxy identity exposed by probe/read adapters after deterministic detection.
export type EvmProxyResolution = {
    kind: EvmProxyKind;
    confidence: EvmProxyConfidence;
    implementationAddress: `0x${string}`;
    beaconAddress: `0x${string}` | null;
};

// EIP-1167 runtime bytecode before the embedded 20-byte implementation address.
const EIP1167_MINIMAL_PROXY_RUNTIME_PREFIX = "363d3d373d3d3d363d73";
// EIP-1167 runtime bytecode after the embedded 20-byte implementation address.
const EIP1167_MINIMAL_PROXY_RUNTIME_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
const EVM_ADDRESS_HEX_LENGTH = 40;
const EVM_STORAGE_WORD_HEX_LENGTH = 64;

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

// Detects ERC-1967 implementation-slot proxies from a raw storage word.
export function detectErc1967ImplementationProxy(
    slotValue: `0x${string}` | string | null | undefined,
): EvmProxyResolution | null {
    const implementationAddress = readEvmAddressFromStorageSlot(slotValue);
    if (!implementationAddress) return null;

    return proxyResolution({
        kind: EVM_PROXY_KIND.Erc1967Implementation,
        implementationAddress,
        beaconAddress: null,
    });
}

// Reads an ERC-1967 beacon address from a raw beacon storage word.
export function readErc1967BeaconAddress(
    slotValue: `0x${string}` | string | null | undefined,
): `0x${string}` | null {
    return readEvmAddressFromStorageSlot(slotValue);
}

// Detects ERC-1967 beacon proxies after the beacon implementation is known.
export function detectErc1967BeaconProxy(input: {
    beaconAddress: `0x${string}` | string | null | undefined;
    implementationAddress: `0x${string}` | string | null | undefined;
}): EvmProxyResolution | null {
    const beaconAddress = normalizeEvmAddress(input.beaconAddress);
    const implementationAddress = normalizeEvmAddress(
        input.implementationAddress,
    );
    if (!beaconAddress || !implementationAddress) return null;

    return proxyResolution({
        kind: EVM_PROXY_KIND.Erc1967Beacon,
        implementationAddress,
        beaconAddress,
    });
}

function detectEip1167MinimalProxy(
    bytecode: string,
): EvmProxyResolution | null {
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
        confidence: EVM_PROXY_CONFIDENCE.Deterministic,
        implementationAddress: `0x${implementation}`,
        beaconAddress: null,
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

function readEvmAddressFromStorageSlot(
    slotValue: `0x${string}` | string | null | undefined,
): `0x${string}` | null {
    const normalized = normalizeHexStorageWord(slotValue);
    if (!normalized) return null;

    const address = normalized.slice(
        EVM_STORAGE_WORD_HEX_LENGTH - EVM_ADDRESS_HEX_LENGTH,
    );
    if (!isAddressHex(address) || isZeroHex(address)) return null;
    return `0x${address}`;
}

function normalizeHexStorageWord(
    slotValue: `0x${string}` | string | null | undefined,
): string | null {
    if (typeof slotValue !== "string") return null;
    const trimmed = slotValue.trim().toLowerCase();
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    return hex.length === EVM_STORAGE_WORD_HEX_LENGTH && /^[a-f0-9]+$/.test(hex)
        ? hex
        : null;
}

function normalizeEvmAddress(
    address: `0x${string}` | string | null | undefined,
): `0x${string}` | null {
    if (typeof address !== "string") return null;
    const trimmed = address.trim().toLowerCase();
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    if (!isAddressHex(hex) || isZeroHex(hex)) return null;
    return `0x${hex}`;
}

function isZeroHex(value: string): boolean {
    return /^0+$/.test(value);
}

function proxyResolution(input: {
    kind: EvmProxyKind;
    implementationAddress: `0x${string}`;
    beaconAddress: `0x${string}` | null;
}): EvmProxyResolution {
    return {
        kind: input.kind,
        confidence: EVM_PROXY_CONFIDENCE.Deterministic,
        implementationAddress: input.implementationAddress,
        beaconAddress: input.beaconAddress,
    };
}
