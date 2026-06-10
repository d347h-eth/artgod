import { createHash } from "node:crypto";
import { keccak256, toHex, concatHex, type Hex } from "viem";
import type {
    TokenSetAttribute,
    TokenSetSchema,
} from "../../domain/token-sets.js";
import { TOKEN_SET_SCHEMA_KIND } from "../../domain/token-sets.js";

const ZERO_HASH =
    "0x0000000000000000000000000000000000000000000000000000000000000000";

export function buildAttributeSchema(
    collection: string,
    attributes: TokenSetAttribute[],
): TokenSetSchema {
    return {
        kind: TOKEN_SET_SCHEMA_KIND.Attribute,
        data: {
            collection,
            attributes,
        },
    };
}

export function buildCollectionSchema(collection: string): TokenSetSchema {
    return {
        kind: TOKEN_SET_SCHEMA_KIND.Collection,
        data: {
            collection,
        },
    };
}

export function normalizeSchema(schema: TokenSetSchema): TokenSetSchema {
    if (schema.kind !== TOKEN_SET_SCHEMA_KIND.Attribute) return schema;
    const deduped = dedupeAndSortAttributes(schema.data.attributes);
    return {
        kind: TOKEN_SET_SCHEMA_KIND.Attribute,
        data: {
            collection: schema.data.collection,
            attributes: deduped,
        },
    };
}

export function generateSchemaHash(schema?: TokenSetSchema): string {
    if (!schema) return ZERO_HASH;
    const normalized = normalizeSchema(schema);
    const json = JSON.stringify(normalized);
    // Seaport-compatible schema fingerprint: sha256(stable json).
    return `0x${createHash("sha256").update(json).digest("hex")}`;
}

export function buildTokenSetId(contract: string, merkleRoot: string): string {
    return `list:${contract}:${merkleRoot}`;
}

export function generateMerkleRoot(tokenIds: string[]): string {
    if (tokenIds.length === 0) {
        throw new Error("Cannot build merkle root from empty tokenIds");
    }
    const leaves = tokenIds.map(hashTokenId).sort(compareHex);
    let level = leaves;
    while (level.length > 1) {
        const next: Hex[] = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = level[i + 1];
            if (!right) {
                // Mirror merkletreejs behavior: promote the odd leaf unchanged.
                next.push(left);
                continue;
            }
            const pair: Hex[] = [left, right].sort(compareHex);
            next.push(keccak256(concatHex(pair)));
        }
        level = next;
    }
    const root = level[0];
    if (!root) {
        throw new Error("Failed to derive merkle root");
    }
    return root;
}

function hashTokenId(tokenId: string): Hex {
    const value = BigInt(tokenId);
    const padded = toHex(value, { size: 32 });
    return keccak256(padded);
}

function compareHex(a: Hex, b: Hex): number {
    if (a === b) return 0;
    return Buffer.compare(
        Buffer.from(a.slice(2), "hex"),
        Buffer.from(b.slice(2), "hex"),
    );
}

function dedupeAndSortAttributes(
    attributes: TokenSetAttribute[],
): TokenSetAttribute[] {
    const seen = new Set<string>();
    const deduped: TokenSetAttribute[] = [];
    for (const attribute of attributes) {
        const key = attribute.key.trim();
        const value = attribute.value.trim();
        if (!key || !value) continue;
        const signature = `${key}:${value}`;
        if (seen.has(signature)) continue;
        seen.add(signature);
        deduped.push({ key, value });
    }
    return deduped.sort((a, b) => {
        const keyCompare = a.key.localeCompare(b.key);
        if (keyCompare !== 0) return keyCompare;
        return a.value.localeCompare(b.value);
    });
}
