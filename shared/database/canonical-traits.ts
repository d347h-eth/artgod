import { db } from "./db.js";
import type { TraitFilter } from "../types/browse.js";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "../types/token-attributes.js";

/** Read-only relation of strict marketplace source pairs. SQLite can push outer scope predicates into the indexed links. */
export const CANONICAL_TRAIT_RELATION_SQL = `
    SELECT t.chain_id,t.collection_id,t.token_id,k.key,a.value FROM token_attributes t
    JOIN attributes a ON a.id=t.attribute_id
    JOIN attribute_keys k ON k.id=a.attribute_key_id
    WHERE t.source_kind='${TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata}' AND t.source_key='${TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY}'
`;

/** Exact native facts, including distinct values which share one canonical key. */
export function readCanonicalTokenTraits(
    chainId: number,
    collectionId: number,
    tokenId: string,
): TraitFilter[] {
    return db
        .prepare(
            `
      SELECT key,value FROM (${CANONICAL_TRAIT_RELATION_SQL}) WHERE chain_id=? AND collection_id=? AND token_id=?
      ORDER BY key,value
    `,
        )
        .all(chainId, collectionId, tokenId) as TraitFilter[];
}
