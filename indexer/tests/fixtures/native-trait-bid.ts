import { db } from "@artgod/shared/database";
import { getSettingDefault } from "@artgod/shared/config/generated-settings-defaults";
import {
    SqliteChainsReadModel,
    SqliteCollectionsReadModel,
} from "@artgod/shared/read-models";
import type { TraitFilter } from "@artgod/shared/types/browse";
import { TOKEN_SET_SCHEMA_KIND } from "@artgod/shared/types/token-sets";
import {
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND,
    TRADING_JOB_STATUS,
    TRADING_JOB_TARGET_KIND,
} from "@artgod/shared/types";
import { ExtensionAwareCollectionDetailRead } from "../../../backend/src/infra/collections/extension-aware-collection-detail-read.js";
import { SqliteCollectionExtensionRecords } from "../../../backend/src/infra/collections/sqlite-collection-extension-records.js";
import { SqliteNativeTokenRead } from "../../../backend/src/infra/trading/sqlite-native-token-read.js";
import { SqliteBiddingBidBookRepository } from "../../../backend/src/infra/trading/sqlite-bidding-bid-book-repository.js";
import { SqliteBiddingJobsRepository } from "../../../backend/src/infra/trading/sqlite-bidding-jobs-repository.js";
import { SqliteBiddingPriceTiersRepository } from "../../../backend/src/infra/trading/sqlite-bidding-price-tiers-repository.js";
import { ApplyBiddingPriceTierReapplyUseCase } from "../../../backend/src/application/use-cases/trading/apply-bidding-price-tier-reapply.js";
import { GetTokenBiddingBidBookUseCase } from "../../../backend/src/application/use-cases/trading/get-token-bidding-bid-book.js";
import { UpsertCollectionBiddingPriceTierUseCase } from "../../../backend/src/application/use-cases/trading/upsert-collection-bidding-price-tier.js";
import { UpsertTraitBiddingJobUseCase } from "../../../backend/src/application/use-cases/trading/upsert-trait-bidding-job.js";
import { NFT111K_TEST_OWNER } from "./111k-bootstrap.js";

export function seedNativeTraitBid(
    {
        chainId,
        collectionId,
        contract,
        collectionSlug,
    }: {
        chainId: number;
        collectionId: number;
        contract: string;
        collectionSlug: string;
    },
    facts: TraitFilter[],
) {
    const refs = { chainRef: String(chainId), collectionRef: collectionSlug };
    const currency = getSettingDefault("WETH_ADDRESS").toLowerCase();
    const chains = new SqliteChainsReadModel();
    const base = new SqliteCollectionsReadModel([currency]);
    const collections = new ExtensionAwareCollectionDetailRead(
        base,
        new SqliteCollectionExtensionRecords(),
    );
    const jobs = new SqliteBiddingJobsRepository();
    const tiers = new SqliteBiddingPriceTiersRepository();
    const signal = { publishBiddingJobCommandsChanged() {} };
    const priceTiers = new UpsertCollectionBiddingPriceTierUseCase(
        chainId,
        chains,
        collections,
        tiers,
    );
    const saveTier = (floorEth: string, tierId?: string) =>
        priceTiers.upsertCollectionBiddingPriceTier({
            ...refs,
            tierId,
            name: "Fixture",
            status: TRADING_JOB_STATUS.Enabled,
            sortOrder: 0,
            parentTierId: null,
            floorConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND.Fixed,
                valueEth: floorEth,
            },
            ceilingConfig: {
                kind: TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND.Fixed,
                valueEth: "0.2",
            },
            deltaEth: "0.01",
        }).tier;
    const tier = saveTier("0.10");
    const targetTraits = facts.map(({ key, value }) => ({ type: key, value }));
    const { job } = new UpsertTraitBiddingJobUseCase(
        chainId,
        chains,
        collections,
        base,
        jobs,
        tiers,
        signal,
    ).upsertTraitBiddingJob({
        ...refs,
        status: TRADING_JOB_STATUS.Paused,
        quantity: 1,
        targetTraits,
        priceTierId: tier.tierId,
        deltaEth: "0.01",
    });
    const orderId = "native-trait-order";
    db.prepare(
        `
        INSERT INTO orders(id, chain_id, collection_id, kind, side, source, maker, contract_address,
            source_scope_kind, source_schema_json, quantity, price, currency, valid_from, valid_until,
            fillability_status, source_status, created_at, updated_at)
        VALUES (?, ?, ?, 'seaport', 'buy', 'opensea', ?, ?, 'attribute', ?, '1', '100000000000000000', ?,
            1, 4000000000, 'fillable', 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `,
    ).run(
        orderId,
        chainId,
        collectionId,
        NFT111K_TEST_OWNER,
        contract,
        JSON.stringify({
            kind: TOKEN_SET_SCHEMA_KIND.Attribute,
            data: { collection: contract, attributes: facts },
        }),
        currency,
    );
    const books = new GetTokenBiddingBidBookUseCase(
        chainId,
        chains,
        new SqliteNativeTokenRead(collections),
        new SqliteBiddingBidBookRepository(),
    );
    return {
        job,
        lookup: () =>
            jobs.findJobByTarget({
                chainId,
                collectionId,
                target: {
                    targetKind: TRADING_JOB_TARGET_KIND.Collection,
                    quantity: 1,
                    targetTraits,
                },
            }),
        storedOrder: () =>
            db
                .prepare(
                    "SELECT id,source_scope_kind,source_schema_json,source_encoded_token_ids FROM orders WHERE chain_id=? AND collection_id=? AND id=?",
                )
                .get(chainId, collectionId, orderId),
        async orderScope(tokenRef: string, view: string, generation: number) {
            const { bidBook } = await books.getTokenBiddingBidBook({
                ...refs,
                tokenRef,
                view,
                generation,
                includeOwnJobContext: false,
            });
            return bidBook.bids.find((bid) => bid.orderId === orderId)?.scope;
        },
        reapply() {
            saveTier("0.15", tier.tierId);
            return new ApplyBiddingPriceTierReapplyUseCase(
                chainId,
                chains,
                collections,
                jobs,
                tiers,
                signal,
            ).applyBiddingPriceTierReapply({
                ...refs,
                tierId: tier.tierId,
                jobIds: [job.jobId],
            }).jobs;
        },
    };
}
