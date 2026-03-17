import type {
    TokenSetSchema,
    TokenSetResolution,
} from "../domain/token-sets.js";

export type TokenSetRequest = {
    chainId: number;
    collectionId: number;
    schema: TokenSetSchema;
};

export interface TokenSetRegistryPort {
    ensureTokenSet(request: TokenSetRequest): TokenSetResolution | null;
}
