import { mkdir, mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { db, setDbPath } from "@artgod/shared/database";
import { createMigrationRunner } from "@artgod/shared/migrations";
import {
    SqliteChainsReadModel,
    SqliteCollectionsReadModel,
    SqliteActivitiesReadModel,
} from "@artgod/shared/read-models";
import {
    ACTIVITY_KIND,
    ACTIVITY_SCOPE_KIND,
    ACTIVITY_SOURCE_KIND,
} from "@artgod/shared/types";
import { GetCollectionDetailUseCase } from "../src/application/use-cases/collections/get-collection-detail.js";
import {
    GetCollectionDetailHttpAdapter,
    type GetCollectionDetailRoute,
} from "../src/http/handlers/collections/get-collection-detail.js";
import { GetTokenActivityUseCase } from "../src/application/use-cases/activities/get-token-activity.js";
import {
    GetTokenActivityHttpAdapter,
    type GetTokenActivityRoute,
} from "../src/http/handlers/activities/get-token-activity.js";
import { ExtensionAwareCollectionDetailRead } from "../src/infra/collections/extension-aware-collection-detail-read.js";
import { ExtensionAwareCollectionCustomization } from "../src/infra/collections/extension-aware-collection-customization.js";
import { SqliteCollectionExtensionRecords } from "../src/infra/collections/sqlite-collection-extension-records.js";
import { SqliteCollectionCustomizationRecords } from "../src/infra/collections/sqlite-collection-customization-records.js";
import { SqliteOrdersDomain } from "../../indexer/src/infra/domain/orders.js";
import { SqliteOrderValidationDemand } from "../../indexer/src/infra/orders/sqlite-order-validation-demand.js";
import { ApplyOrderUpdate } from "../../indexer/src/application/orders/apply-order-update.js";
import { AdmitOrderValidation } from "../../indexer/src/application/orders/validate-order-demand.js";
import { ORDER_UPDATE_REASON } from "../../indexer/src/domain/order-jobs.js";
import { ORDER_SOURCE_STATUS } from "../../indexer/src/domain/orders.js";
import {
    HEAVY_MAKER,
    seedHeavyMaker,
} from "../../indexer/tests/fixtures/heavy-maker.js";

afterEach(() => vi.restoreAllMocks());

it("removes a processed sale from current asks through HTTP while preserving ownership and sale history", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const base = path.join(root, "tmp/order-lifecycle-api");
    await mkdir(base, { recursive: true });
    setDbPath(
        path.join(await mkdtemp(path.join(base, "run-")), "orders.sqlite"),
    );
    vi.spyOn(Date, "now").mockReturnValue(HEAVY_MAKER.now * 1000);
    await createMigrationRunner().runMigrations();
    const app = Fastify();
    try {
        const { sale } = seedHeavyMaker(1);
        // Represent the already-applied onchain projection from the reported incident.
        // The order queue must not erase these independent durable facts.
        db.prepare(
            "INSERT INTO tokens(chain_id,collection_id,contract_address,token_id) VALUES (?,?,?,?)",
        ).run(sale.chainId, sale.collectionId, sale.contract, sale.tokenId);
        db.prepare(
            "INSERT INTO nft_balances(chain_id,collection_id,contract_address,token_id,owner,amount,last_block_number,last_block_hash,last_block_timestamp,last_tx_hash,last_log_index) VALUES (?,?,?,?,?,'1',?,'0xblock',?,'0xsale',0)",
        ).run(
            sale.chainId,
            sale.collectionId,
            sale.contract,
            sale.tokenId,
            HEAVY_MAKER.smallMaker,
            HEAVY_MAKER.blockNumber,
            HEAVY_MAKER.now,
        );
        db.prepare(
            "INSERT INTO activities(chain_id,collection_id,scope_kind,kind,contract_address,token_id,occurred_at,source_kind,source_name,order_id,block_number,tx_hash,log_index,from_address,to_address,maker,taker,side,amount,price,currency,dedupe_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'sell','1',?,?,'fixture:sale')",
        ).run(
            sale.chainId,
            sale.collectionId,
            ACTIVITY_SCOPE_KIND.Token,
            ACTIVITY_KIND.Sale,
            sale.contract,
            sale.tokenId,
            HEAVY_MAKER.now,
            ACTIVITY_SOURCE_KIND.Onchain,
            "seaport",
            sale.id,
            HEAVY_MAKER.blockNumber,
            "0xsale",
            0,
            sale.maker,
            HEAVY_MAKER.smallMaker,
            sale.maker,
            HEAVY_MAKER.smallMaker,
            sale.price,
            sale.currency,
        );
        const extensions = new SqliteCollectionExtensionRecords();
        const read = new ExtensionAwareCollectionDetailRead(
            new SqliteCollectionsReadModel([HEAVY_MAKER.weth]),
            extensions,
        );
        const custom = new ExtensionAwareCollectionCustomization(
            extensions,
            new SqliteCollectionCustomizationRecords(),
        );
        const chains = new SqliteChainsReadModel();
        const detail = new GetCollectionDetailHttpAdapter(
            new GetCollectionDetailUseCase(1, chains, read, custom),
        );
        const activity = new GetTokenActivityHttpAdapter(
            new GetTokenActivityUseCase(
                1,
                chains,
                read,
                new SqliteActivitiesReadModel(),
                read,
                custom,
            ),
        );
        app.get<GetCollectionDetailRoute>(
            "/api/:chain_ref/:collection_ref",
            detail.handle,
        );
        app.get<GetTokenActivityRoute>(
            "/api/:chain_ref/:collection_ref/:token_ref/activity",
            activity.handle,
        );
        const url = `/api/ethereum/heavy-maker-${sale.collectionId}`;
        const fetch = async (endpoint: string) => {
            const response = await app.inject(endpoint);
            expect(response.statusCode, response.body).toBe(200);
            return response.json();
        };
        expect((await fetch(url)).tokens.items).toMatchObject([
            { tokenId: sale.tokenId, listingPrice: sale.price },
        ]);
        const before = await fetch(`${url}/${sale.tokenId}/activity`);
        expect(before.token.currentHolder).toBe(HEAVY_MAKER.smallMaker);
        expect(before.activities.items).toHaveLength(1);
        const domain = new SqliteOrdersDomain(HEAVY_MAKER.weth, async () => {
            throw new Error("A lifecycle fact must not wait for RPC");
        });
        const processor = new ApplyOrderUpdate({
            chainId: 1,
            validation: new AdmitOrderValidation(
                1,
                new SqliteOrderValidationDemand(domain),
            ),
            lifecycle: domain,
        });
        await processor.execute(
            {
                chainId: 1,
                collectionId: sale.collectionId,
                orderId: sale.id,
                reason: ORDER_UPDATE_REASON.Fill,
                sourceStatus: ORDER_SOURCE_STATUS.Filled,
                observedAt: HEAVY_MAKER.now,
            },
            HEAVY_MAKER.now * 1000,
        );
        expect((await fetch(url)).tokens.items).toEqual([]);
        const after = await fetch(`${url}/${sale.tokenId}/activity`);
        expect(after.token).toMatchObject({
            currentHolder: HEAVY_MAKER.smallMaker,
            listingPrice: null,
            listingCurrency: null,
        });
        expect(after.activities).toEqual(before.activities);
        expect(after.activities.items[0]).toMatchObject({
            kind: ACTIVITY_KIND.Sale,
            price: sale.price,
            to: HEAVY_MAKER.smallMaker,
        });
    } finally {
        await app.close();
        db.raw.close();
    }
});
