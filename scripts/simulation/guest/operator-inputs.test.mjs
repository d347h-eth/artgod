import assert from "node:assert/strict";
import test from "node:test";
import { declareTradingIntent } from "./operator-inputs.mjs";
import {
    API_CSRF_HEADER_NAME,
    API_CSRF_COOKIE_NAME,
} from "../../../shared/http/api-security.ts";
import { TRADING_JOB_STATUS } from "../../../shared/types/trading.ts";

test("operator intent uses real CSRF negotiation and both paused declarations through HTTP", async () => {
    const calls = [];
    const result = await declareTradingIntent({
        origin: "http://127.0.0.1:42722",
        chainRef: "ethereum",
        collectionRef: "simulation",
        tokenRef: "1",
        fetchFn: async (url, options) => {
            calls.push({ url, ...options });
            return Response.json(
                calls.length === 1
                    ? { token: "fixture-token" }
                    : calls.length === 2
                      ? { tier: { tierId: "actual-created-tier" } }
                      : { job: { jobId: "actual-created-job" } },
            );
        },
    });
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url, "http://127.0.0.1:42722/api/security/csrf");
    assert.equal(
        calls[1].url,
        "http://127.0.0.1:42722/api/ethereum/simulation/bidding/price-tiers",
    );
    assert.equal(
        calls[2].url,
        "http://127.0.0.1:42722/api/ethereum/simulation/1/bidding/job",
    );
    for (const call of calls.slice(1)) {
        assert.equal(call.method, "PUT");
        assert.equal(call.headers[API_CSRF_HEADER_NAME], "fixture-token");
        assert.equal(
            call.headers.cookie,
            `${API_CSRF_COOKIE_NAME}=fixture-token`,
        );
        assert.equal(call.headers.origin, "http://127.0.0.1:42722");
        assert.equal(JSON.parse(call.body).status, TRADING_JOB_STATUS.Paused);
    }
    assert.equal(JSON.parse(calls[2].body).priceTierId, "actual-created-tier");
    assert.equal(result.jobId, "actual-created-job");
});

test("operator setup rejects missing context, failed HTTP and missing created identities", async () => {
    await assert.rejects(declareTradingIntent({}), /requires/);
    const context = {
        origin: "http://127.0.0.1:42722",
        chainRef: "ethereum",
        collectionRef: "simulation",
        tokenRef: "1",
    };
    await assert.rejects(
        declareTradingIntent({
            ...context,
            fetchFn: async () => new Response("denied", { status: 403 }),
        }),
        /HTTP 403/,
    );
    await assert.rejects(
        declareTradingIntent({
            ...context,
            fetchFn: async () => Response.json({ token: "" }),
        }),
        /actual CSRF/,
    );
    await assert.rejects(
        declareTradingIntent({
            ...context,
            fetchFn: async () => Response.json({ token: "fixture-token" }),
        }),
        /create a price tier/,
    );
});
