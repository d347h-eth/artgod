import { db } from "@artgod/shared/database";
import { TOKEN_RECORD_KIND } from "@artgod/shared/types/token-records";
import type {
    MetadataRefreshRangeTokenSelection,
    MetadataRefreshRangeTokenSource,
} from "../../application/metadata/refresh-range.js";

/** Inventory, not numeric ID space. Balances include known tokens awaiting their first metadata. */
export class SqliteMetadataRangeTokens implements MetadataRefreshRangeTokenSource {
    private readonly select = db.prepare<
        MetadataRefreshRangeTokenSelection & {
            fromLength: number;
            toLength: number;
            recordKind: string;
        }
    >(
        // Preserve ordered seeks even if kind selectivity makes a filter index look cheaper.
        "SELECT token_sort_value AS token_id,token_sort_length AS sort_length FROM tokens INDEXED BY tokens_collection_numeric_sort_idx " +
            "WHERE chain_id=@chainId AND collection_id=@collectionId AND token_sort_bucket=0 AND record_kind=@recordKind " +
            "AND (token_sort_length,token_sort_value)>=(@fromLength,@fromTokenId) " +
            "AND (token_sort_length,token_sort_value)<=(@toLength,@toTokenId) " +
            "UNION " +
            // On-chain ingress stores balance IDs as normalized unsigned decimal text.
            "SELECT token_id,length(token_id) AS sort_length FROM nft_balances INDEXED BY nft_balances_collection_numeric_token_idx " +
            "WHERE chain_id=@chainId AND collection_id=@collectionId AND token_id!='' AND token_id NOT GLOB '*[^0-9]*' " +
            "AND (length(token_id),token_id)>=(@fromLength,@fromTokenId) " +
            "AND (length(token_id),token_id)<=(@toLength,@toTokenId) " +
            "ORDER BY sort_length,token_id LIMIT @limit",
    );

    listTokenIds(input: MetadataRefreshRangeTokenSelection): string[] {
        // Both UNION arms seek their numeric index; the compound reader merges and deduplicates.
        const rows = this.select.all({
            ...input,
            fromLength: input.fromTokenId.length,
            toLength: input.toTokenId.length,
            recordKind: TOKEN_RECORD_KIND.Canonical,
        }) as { token_id: string }[];
        return rows.map((row) => row.token_id);
    }
}
