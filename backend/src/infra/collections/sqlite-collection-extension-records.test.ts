import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND } from "@artgod/shared/extensions";
import {
    TERRAFORMS_EXTENSION_KEY,
    TERRAFORMS_VERSION_ATTRIBUTE_KEY,
    TERRAFORMS_VERSION_ATTRIBUTE_VALUES,
} from "@artgod/shared/extensions/terraforms";
import { createMigrationRunner } from "@artgod/shared/migrations";
import { COLLECTION_STANDARD, COLLECTION_STATUS } from "@artgod/shared/types";
import {
    TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    TOKEN_ATTRIBUTE_SOURCE_KIND,
} from "@artgod/shared/types/token-attributes";
import { TOKEN_RECORD_KIND } from "@artgod/shared/types/token-records";
import { SqliteCollectionExtensionRecords } from "./sqlite-collection-extension-records.js";

const FIXTURE_CHAIN_ID = 1;
const FIXTURE_COLLECTION_SLUG = "extension-media-facts";
const FIXTURE_COLLECTION_ADDRESS = "0x1111111111111111111111111111111111111111";
const FIXTURE_TOKEN_ID = "42";
const FIXTURE_ANIMATION_URL = "https://example.com/42.html";
const NON_CANONICAL_VERSION_VALUE = "extension-version";

describe("SqliteCollectionExtensionRecords", () => {
    let collectionId = 0;

    beforeEach(async () => {
        const directory = await mkdtemp(
            join(tmpdir(), "artgod-extension-media-facts-"),
        );
        setDbPath(join(directory, "main.sqlite"));
        await createMigrationRunner().runMigrations();
        collectionId = seedCollection();
        seedCanonicalMediaFacts(collectionId);
    });

    it("returns only canonical metadata attributes with canonical media facts", () => {
        const records = new SqliteCollectionExtensionRecords();

        const facts = records.getCanonicalTokenMediaFacts({
            chainId: FIXTURE_CHAIN_ID,
            collectionId,
            tokenId: FIXTURE_TOKEN_ID,
        });

        expect(facts.isCanonicalToken).toBe(true);
        expect(facts.animationUrl).toBe(FIXTURE_ANIMATION_URL);
        expect(facts.attributes).toEqual(
            new Map([
                [
                    TERRAFORMS_VERSION_ATTRIBUTE_KEY,
                    TERRAFORMS_VERSION_ATTRIBUTE_VALUES.V2,
                ],
            ]),
        );
    });
});

function seedCollection(): number {
    const result = db
        .prepare<{
            chainId: number;
            slug: string;
            address: string;
            standard: string;
            status: string;
            tokenScopeKind: string;
        }>(
            "INSERT INTO collections " +
                "(chain_id, slug, address, standard, status, token_scope_kind) " +
                "VALUES (@chainId, @slug, @address, @standard, @status, @tokenScopeKind)",
        )
        .run({
            chainId: FIXTURE_CHAIN_ID,
            slug: FIXTURE_COLLECTION_SLUG,
            address: FIXTURE_COLLECTION_ADDRESS,
            standard: COLLECTION_STANDARD.Erc721,
            status: COLLECTION_STATUS.Live,
            tokenScopeKind:
                EMBEDDED_COLLECTION_EXTENSION_SCOPE_KIND.AllContractTokens,
        });
    return Number(result.lastInsertRowid);
}

function seedCanonicalMediaFacts(collectionId: number): void {
    db.prepare(
        "INSERT INTO tokens " +
            "(chain_id, collection_id, contract_address, token_id, record_kind) " +
            "VALUES (?, ?, ?, ?, ?)",
    ).run(
        FIXTURE_CHAIN_ID,
        collectionId,
        FIXTURE_COLLECTION_ADDRESS,
        FIXTURE_TOKEN_ID,
        TOKEN_RECORD_KIND.Canonical,
    );
    db.prepare(
        "INSERT INTO token_metadata " +
            "(chain_id, collection_id, contract_address, token_id, uri, animation_url) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
        FIXTURE_CHAIN_ID,
        collectionId,
        FIXTURE_COLLECTION_ADDRESS,
        FIXTURE_TOKEN_ID,
        "ipfs://42",
        FIXTURE_ANIMATION_URL,
    );

    const keyResult = db
        .prepare(
            "INSERT INTO attribute_keys " +
                "(chain_id, collection_id, contract_address, key) VALUES (?, ?, ?, ?)",
        )
        .run(
            FIXTURE_CHAIN_ID,
            collectionId,
            FIXTURE_COLLECTION_ADDRESS,
            TERRAFORMS_VERSION_ATTRIBUTE_KEY,
        );
    const keyId = Number(keyResult.lastInsertRowid);
    const canonicalAttributeId = insertAttribute(
        collectionId,
        keyId,
        TERRAFORMS_VERSION_ATTRIBUTE_VALUES.V2,
    );
    const extensionAttributeId = insertAttribute(
        collectionId,
        keyId,
        NON_CANONICAL_VERSION_VALUE,
    );
    insertTokenAttribute(
        collectionId,
        canonicalAttributeId,
        TOKEN_ATTRIBUTE_SOURCE_KIND.Metadata,
        TOKEN_ATTRIBUTE_METADATA_SOURCE_KEY,
    );
    insertTokenAttribute(
        collectionId,
        extensionAttributeId,
        TOKEN_ATTRIBUTE_SOURCE_KIND.CollectionExtension,
        TERRAFORMS_EXTENSION_KEY,
    );
}

function insertAttribute(
    collectionId: number,
    keyId: number,
    value: string,
): number {
    const result = db
        .prepare(
            "INSERT INTO attributes " +
                "(chain_id, collection_id, contract_address, attribute_key_id, value) " +
                "VALUES (?, ?, ?, ?, ?)",
        )
        .run(
            FIXTURE_CHAIN_ID,
            collectionId,
            FIXTURE_COLLECTION_ADDRESS,
            keyId,
            value,
        );
    return Number(result.lastInsertRowid);
}

function insertTokenAttribute(
    collectionId: number,
    attributeId: number,
    sourceKind: string,
    sourceKey: string,
): void {
    db.prepare(
        "INSERT INTO token_attributes " +
            "(chain_id, collection_id, contract_address, token_id, attribute_id, source_kind, source_key) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
        FIXTURE_CHAIN_ID,
        collectionId,
        FIXTURE_COLLECTION_ADDRESS,
        FIXTURE_TOKEN_ID,
        attributeId,
        sourceKind,
        sourceKey,
    );
}
