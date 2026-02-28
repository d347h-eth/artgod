import { db } from "../database/db.js";
import type { ChainRecord } from "../types/browse.js";
import {
    isSlugRef,
    normalizeSlugRef,
    parsePublicChainIdRef,
} from "../utils/ref-resolver.js";
import { ReadModelBadRequestError, ReadModelNotFoundError } from "./errors.js";

type ChainRow = {
    id: number;
    type: string;
    public_chain_id: number;
    slug: string;
    name: string;
};

export class SqliteChainsReadModel {
    private selectByPublicId = db.prepare<{
        type: string;
        publicChainId: number;
    }>(
        "SELECT id, type, public_chain_id, slug, name " +
            "FROM chains " +
            "WHERE type = @type AND public_chain_id = @publicChainId " +
            "LIMIT 1",
    );

    private selectBySlug = db.prepare<{ type: string; slug: string }>(
        "SELECT id, type, public_chain_id, slug, name " +
            "FROM chains " +
            "WHERE type = @type AND slug = @slug " +
            "LIMIT 1",
    );

    getDefaultChain(defaultPublicChainId: number): ChainRecord {
        return this.resolveByPublicChainId(defaultPublicChainId);
    }

    resolveChainRef(
        chainRef: string | undefined,
        defaultPublicChainId: number,
    ): ChainRecord {
        if (!chainRef || !chainRef.trim()) {
            return this.getDefaultChain(defaultPublicChainId);
        }

        const publicChainId = parsePublicChainIdRef(chainRef);
        if (publicChainId !== null) {
            return this.resolveByPublicChainId(publicChainId);
        }

        if (!isSlugRef(chainRef)) {
            throw new ReadModelBadRequestError("Invalid chain_ref");
        }

        const slug = normalizeSlugRef(chainRef);
        const row = this.selectBySlug.get({
            type: "evm",
            slug,
        }) as ChainRow | undefined;
        if (!row) {
            throw new ReadModelNotFoundError("Unknown chain_ref");
        }
        return mapChainRow(row);
    }

    private resolveByPublicChainId(publicChainId: number): ChainRecord {
        const row = this.selectByPublicId.get({
            type: "evm",
            publicChainId,
        }) as ChainRow | undefined;
        if (!row) {
            throw new ReadModelNotFoundError("Unknown public chain id");
        }
        return mapChainRow(row);
    }
}

function mapChainRow(row: ChainRow): ChainRecord {
    return {
        id: row.id,
        type: row.type,
        publicChainId: row.public_chain_id,
        slug: row.slug,
        name: row.name,
    };
}
