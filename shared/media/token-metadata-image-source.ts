import { resolveTokenResourceUri } from "./token-resource-uri.js";

// Metadata field names commonly used as token image sources.
export const TOKEN_METADATA_IMAGE_SOURCE_FIELD = {
    Image: "image",
    ImageUrl: "image_url",
    ImageData: "image_data",
    SvgImageData: "svg_image_data",
} as const;

// Preferred image fields are tried before the fallback heuristics.
export const TOKEN_METADATA_PREFERRED_IMAGE_SOURCE_FIELDS = [
    TOKEN_METADATA_IMAGE_SOURCE_FIELD.Image,
    TOKEN_METADATA_IMAGE_SOURCE_FIELD.ImageUrl,
    TOKEN_METADATA_IMAGE_SOURCE_FIELD.ImageData,
    TOKEN_METADATA_IMAGE_SOURCE_FIELD.SvgImageData,
] as const;

const IMAGE_DATA_URI_PREFIX = "data:image/";
const IMAGE_SOURCE_FIELD_NAME_FRAGMENT = "image";
const IMAGE_FILE_EXTENSIONS = [
    ".avif",
    ".bmp",
    ".gif",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".webp",
] as const;

export type TokenMetadataImageSourceSelection = {
    field: string;
    value: string;
};

export type TokenMetadataImageSourceSelectionInput = {
    metadata: Record<string, unknown>;
    requestedField?: string | null;
    ipfsGatewayOrigin?: string;
};

// Selects the metadata field that should populate canonical token image media.
export function selectTokenMetadataImageSource(
    input: TokenMetadataImageSourceSelectionInput,
): TokenMetadataImageSourceSelection | null {
    const requestedField = normalizeTokenMetadataImageSourceField(
        input.requestedField,
    );
    if (requestedField) {
        return selectField(input.metadata, requestedField, input);
    }

    for (const field of TOKEN_METADATA_PREFERRED_IMAGE_SOURCE_FIELDS) {
        const selection = selectField(input.metadata, field, input);
        if (selection) return selection;
    }

    for (const [field, value] of Object.entries(input.metadata)) {
        if (!field.toLowerCase().includes(IMAGE_SOURCE_FIELD_NAME_FRAGMENT)) {
            continue;
        }
        const source = normalizeMetadataImageSourceValue(value, input);
        if (source) return { field, value: source };
    }

    for (const [field, value] of Object.entries(input.metadata)) {
        const source = normalizeMetadataImageSourceValue(value, input);
        if (!source || !isClearlyImageSourceValue(source)) continue;
        return { field, value: source };
    }

    return null;
}

// Normalizes user-entered metadata field names without changing their spelling.
export function normalizeTokenMetadataImageSourceField(
    value: string | null | undefined,
): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function selectField(
    metadata: Record<string, unknown>,
    field: string,
    input: TokenMetadataImageSourceSelectionInput,
): TokenMetadataImageSourceSelection | null {
    const source = normalizeMetadataImageSourceValue(metadata[field], input);
    return source ? { field, value: source } : null;
}

function normalizeMetadataImageSourceValue(
    value: unknown,
    input: TokenMetadataImageSourceSelectionInput,
): string | null {
    if (typeof value !== "string") return null;
    const source = value.trim();
    if (!source) return null;
    return resolveTokenResourceUri(source, {
        ipfsGatewayOrigin: input.ipfsGatewayOrigin,
    })
        ? source
        : null;
}

function isClearlyImageSourceValue(value: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (normalized.startsWith(IMAGE_DATA_URI_PREFIX)) return true;
    const path = imageSourcePath(normalized);
    return IMAGE_FILE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function imageSourcePath(value: string): string {
    try {
        return new URL(value).pathname.toLowerCase();
    } catch {
        return value.split(/[?#]/u)[0]?.toLowerCase() ?? "";
    }
}
