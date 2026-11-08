import assert from "node:assert/strict";
import { createOperatorHttp } from "./operator-http.mjs";
import {
    buildBiddingPriceTiersPath,
    buildTokenBiddingJobPath,
} from "../../../shared/http/trading-routes.ts";
import {
    TRADING_JOB_STATUS,
    TRADING_BIDDING_PRICE_TIER_FLOOR_CONFIG_KIND as FLOOR,
    TRADING_BIDDING_PRICE_TIER_CEILING_CONFIG_KIND as CEILING,
} from "../../../shared/types/trading.ts";

/** Operator intent enters the isolated backend through its actual secured HTTP API. */
export async function declareTradingIntent({
    origin,
    chainRef,
    collectionRef,
    tokenRef,
    fetchFn = fetch,
}) {
    for (const [name, value] of Object.entries({
        origin,
        chainRef,
        collectionRef,
        tokenRef,
    }))
        assert.ok(
            typeof value === "string" && value.length > 0,
            `Declared input requires ${name}`,
        );
    const { put } = createOperatorHttp({ origin, fetchFn });
    const tier = await put(
        buildBiddingPriceTiersPath(chainRef, collectionRef),
        {
            name: "simulation-intent",
            status: TRADING_JOB_STATUS.Paused,
            sortOrder: 0,
            parentTierId: null,
            floorConfig: { kind: FLOOR.Fixed, valueEth: "0.12" },
            ceilingConfig: { kind: CEILING.Fixed, valueEth: "0.15" },
            deltaEth: "0.01",
        },
    );
    assert.ok(
        typeof tier.tier?.tierId === "string" && tier.tier.tierId.length > 0,
        "The production API must create a price tier",
    );
    const job = await put(
        buildTokenBiddingJobPath(chainRef, collectionRef, tokenRef),
        {
            status: TRADING_JOB_STATUS.Paused,
            priceTierId: tier.tier.tierId,
            deltaEth: "0.01",
        },
    );
    assert.ok(
        typeof job.job?.jobId === "string" && job.job.jobId.length > 0,
        "The production API must create declared job intent",
    );
    return {
        tierId: tier.tier.tierId,
        jobId: job.job.jobId,
        tokenRef,
        status: TRADING_JOB_STATUS.Paused,
    };
}
