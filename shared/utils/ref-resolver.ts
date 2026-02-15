const ADDRESS_REF_REGEX = /^0x[a-fA-F0-9]{40}$/;
const SLUG_REF_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeAddressRef(value: string): string {
    return value.trim().toLowerCase();
}

export function isAddressRef(value: string): boolean {
    return ADDRESS_REF_REGEX.test(value.trim());
}

export function normalizeSlugRef(value: string): string {
    return value.trim().toLowerCase();
}

export function isSlugRef(value: string): boolean {
    return SLUG_REF_REGEX.test(normalizeSlugRef(value));
}

export function parsePublicChainIdRef(value: string): number | null {
    const normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return null;
    const parsed = Number(normalized);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return parsed;
}
