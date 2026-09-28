import assert from "node:assert/strict";
import Fastify from "fastify";
import { createPublicClient, http } from "viem";
import { BOOTSTRAP_API_ROUTE_TEMPLATE } from "@artgod/shared/http/bootstrap-routes";
import { BOOTSTRAP_TEST_CHAIN } from "@artgod/shared/testing/bootstrap-probe";
import { COMMON_MEDIA_ENV_KEY } from "@artgod/shared/config/common-media";
import { RPC_ENDPOINT_LIST_ENV_KEY } from "@artgod/shared/config/rpc-endpoints";
import { NOOP_APM } from "@artgod/shared/observability/apm";
import { loadBackendConfig } from "../config.js";
import { createBaseEnv } from "../config.test-fixture.js";
import { ProbeCollectionContractUseCase } from "../application/use-cases/bootstrap/probe-collection-contract.js";
import { InspectBootstrapSampleUseCase } from "../application/use-cases/bootstrap/inspect-bootstrap-sample.js";
import { EstimateBootstrapImageCacheUseCase } from "../application/use-cases/bootstrap/estimate-bootstrap-image-cache.js";
import { ViemBackendRpcClient } from "../infra/rpc/viem-backend-rpc.js";
import { ViemBootstrapContractProbe } from "../infra/bootstrap/viem-bootstrap-contract-probe.js";
import { SharpBootstrapImageCacheEstimateAdapter } from "../infra/media/sharp-bootstrap-image-cache-estimate.js";
import { BuiltInCollectionExtensionResolver } from "../infra/collection-extensions/built-in-collection-extension-resolver.js";
import { ProbeCollectionContractHttpAdapter } from "../http/handlers/bootstrap/probe-collection-contract.js";
import { InspectBootstrapSampleHttpAdapter } from "../http/handlers/bootstrap/inspect-bootstrap-sample.js";
import { EstimateBootstrapImageCacheHttpAdapter } from "../http/handlers/bootstrap/estimate-bootstrap-image-cache.js";
import { registerApiErrorHandlers } from "../http/common/error-handlers.js";

/** Real bootstrap HTTP adapters with real RPC/download/Sharp, without a DB,
 * queue, listeners or collection mutations. Chain routing is the only fixture. */
export async function createBootstrapLiveHttp(input: {
    rpcUrl: string;
    ipfsGatewayOrigin: string;
}) {
    const config = loadBackendConfig({
        ...createBaseEnv(),
        [RPC_ENDPOINT_LIST_ENV_KEY]: JSON.stringify([
            { url: input.rpcUrl, weight: 1 },
        ]),
        [COMMON_MEDIA_ENV_KEY.IpfsGatewayOrigin]: input.ipfsGatewayOrigin,
    });
    const chain = BOOTSTRAP_TEST_CHAIN;
    const actualChain = await createPublicClient({
        transport: http(input.rpcUrl),
    }).getChainId();
    assert.equal(
        actualChain,
        chain.publicChainId,
        "Live check requires Ethereum mainnet RPC",
    );
    const chainResolver = {
        resolveChainRef: (chainRef: string) => {
            assert.equal(
                chainRef,
                chain.slug,
                "Live check requires the Ethereum route",
            );
            return chain;
        },
    };
    const rpc = new ViemBackendRpcClient(
        config.rpc.endpoints,
        NOOP_APM,
        undefined,
        {
            retryPolicy: config.rpc.retryPolicy,
            resilience: config.rpc.resilience,
        },
    );
    const probe = new ViemBootstrapContractProbe(
        rpc,
        config.ipfs.gatewayOrigin,
        config.httpFetch,
    );
    const app = Fastify({ logger: false });
    registerApiErrorHandlers(app);
    app.get(
        BOOTSTRAP_API_ROUTE_TEMPLATE.ProbeCollection,
        new ProbeCollectionContractHttpAdapter(
            new ProbeCollectionContractUseCase(chain.id, chainResolver, probe),
        ).handle,
    );
    app.post(
        BOOTSTRAP_API_ROUTE_TEMPLATE.InspectSample,
        new InspectBootstrapSampleHttpAdapter(
            new InspectBootstrapSampleUseCase(
                chain.id,
                chainResolver,
                probe,
                new BuiltInCollectionExtensionResolver(),
                config.ipfs.gatewayOrigin,
            ),
        ).handle,
    );
    app.post(
        BOOTSTRAP_API_ROUTE_TEMPLATE.EstimateImageCache,
        new EstimateBootstrapImageCacheHttpAdapter(
            new EstimateBootstrapImageCacheUseCase(
                chain.id,
                chainResolver,
                new SharpBootstrapImageCacheEstimateAdapter({
                    ipfsGatewayOrigin: config.ipfs.gatewayOrigin,
                    maxSourceBytes: config.bootstrap.imageCacheMaxSourceBytes,
                    fetchResilience: config.httpFetch,
                }),
            ),
        ).handle,
    );
    return app;
}
