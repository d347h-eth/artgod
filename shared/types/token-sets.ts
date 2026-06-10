export const TOKEN_SET_SCHEMA_KIND = {
    Attribute: "attribute",
    Collection: "collection",
} as const;

export type TokenSetSchemaKind =
    (typeof TOKEN_SET_SCHEMA_KIND)[keyof typeof TOKEN_SET_SCHEMA_KIND];

export type TokenSetAttribute = {
    key: string;
    value: string;
};

export type TokenSetAttributeSchema = {
    kind: typeof TOKEN_SET_SCHEMA_KIND.Attribute;
    data: {
        collection: string;
        attributes: TokenSetAttribute[];
    };
};

export type TokenSetCollectionSchema = {
    kind: typeof TOKEN_SET_SCHEMA_KIND.Collection;
    data: {
        collection: string;
    };
};

export type TokenSetSchema = TokenSetAttributeSchema | TokenSetCollectionSchema;

export type TokenSetResolution = {
    tokenSetId: string;
    schemaHash: string;
    merkleRoot: string;
    tokenCount: number;
};

// Validates persisted attribute token-set schemas before consumers trust criteria rows.
export function isTokenSetAttributeSchema(
    value: unknown,
): value is TokenSetAttributeSchema {
    const record = asRecord(value);
    if (record?.kind !== TOKEN_SET_SCHEMA_KIND.Attribute) {
        return false;
    }

    const data = asRecord(record.data);
    if (!data || typeof data.collection !== "string") {
        return false;
    }

    return (
        Array.isArray(data.attributes) &&
        data.attributes.every(isTokenSetAttribute)
    );
}

// Validates persisted collection token-set schemas before consumers trust scope rows.
export function isTokenSetCollectionSchema(
    value: unknown,
): value is TokenSetCollectionSchema {
    const record = asRecord(value);
    if (record?.kind !== TOKEN_SET_SCHEMA_KIND.Collection) {
        return false;
    }

    const data = asRecord(record.data);
    return Boolean(data && typeof data.collection === "string");
}

function isTokenSetAttribute(value: unknown): value is TokenSetAttribute {
    const record = asRecord(value);
    return (
        Boolean(record) &&
        typeof record?.key === "string" &&
        typeof record.value === "string"
    );
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : null;
}
