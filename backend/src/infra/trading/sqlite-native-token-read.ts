import { db } from "@artgod/shared/database";
import { readCanonicalTokenTraits } from "@artgod/shared/database/canonical-traits";
import {
    ReadModelBadRequestError,
    ReadModelNotFoundError,
} from "@artgod/shared/read-models/errors";
import type { TraitReadContext } from "@artgod/shared/types/trait-catalog";
import {
    ensureCatalogToken,
    withTraitReadSnapshot,
    readViewStatus,
    hasCollectionViewGroup,
    readTokenViewId,
} from "@artgod/shared/read-models/trait-catalog";
import type { CollectionListItem } from "@artgod/shared/types/browse";
import { TOKEN_RECORD_KIND } from "@artgod/shared/types/token-records";

/** Exact token jobs and native scope matching need local identity and source-owned facts only. */
export class SqliteNativeTokenRead {
    readonly hasViewGroup = hasCollectionViewGroup;
    readonly readViewStatus = readViewStatus;
    readonly readTokenViewId = readTokenViewId;
    constructor(
        private readonly collections: {
            resolveCollectionRef(
                chainId: number,
                ref: string,
            ): CollectionListItem;
        },
    ) {}
    resolveCollectionRef(chainId: number, ref: string) {
        return this.collections.resolveCollectionRef(chainId, ref);
    }

    getNativeTokenIdentity(params: {
        chainId: number;
        collectionId: number;
        tokenId: string;
    }) {
        const tokenId = params.tokenId.trim();
        if (!tokenId) throw new ReadModelBadRequestError("Invalid token_ref");
        const row = db
            .prepare(
                "SELECT record_kind FROM tokens WHERE chain_id=? AND collection_id=? AND token_id=?",
            )
            .get(params.chainId, params.collectionId, tokenId) as
            | { record_kind: string }
            | undefined;
        if (!row) throw new ReadModelNotFoundError("Unknown token_ref");
        return {
            tokenId,
            marketplaceBiddingSupported:
                row.record_kind === TOKEN_RECORD_KIND.Canonical,
        };
    }

    getCanonicalTokenTraits(
        chainId: number,
        collectionId: number,
        tokenId: string,
        traitContext?: TraitReadContext,
    ) {
        const read = () => {
            if (traitContext)
                ensureCatalogToken(
                    { chainId, collectionId, traitContext },
                    tokenId,
                );
            const identity = this.getNativeTokenIdentity({
                chainId,
                collectionId,
                tokenId,
            });
            return {
                tokenId: identity.tokenId,
                traits: readCanonicalTokenTraits(
                    chainId,
                    collectionId,
                    identity.tokenId,
                ),
            };
        };
        return traitContext
            ? withTraitReadSnapshot(
                  { chainId, collectionId, traitContext },
                  read,
              )
            : db.raw.transaction(read)();
    }
}
