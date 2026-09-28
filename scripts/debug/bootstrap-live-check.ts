import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
    API_CSRF_COOKIE_NAME,
    API_CSRF_HEADER_NAME,
    API_CSRF_ROUTE_PATH,
} from "../../shared/http/api-security.js";
import {
    buildProbeBootstrapCollectionPath,
    buildInspectBootstrapSamplePath,
    buildEstimateBootstrapImageCachePath,
} from "../../shared/http/bootstrap-routes.js";
import { BOOTSTRAP_ENUMERATION_MODE } from "../../shared/bootstrap/pipeline.js";
import { parseBootstrapScope } from "../../shared/bootstrap/scope.js";
import { inspectBootstrapMetadata } from "../../shared/bootstrap/metadata.js";
import type {
    BootstrapContractProbeResponse,
    BootstrapSampleInspectionResponse,
} from "../../shared/bootstrap/probe.js";
import { IMAGE_CACHE_MODE } from "../../shared/media/token-image-cache.js";
import { COLLECTION_STANDARD } from "../../shared/types/browse.js";
import { normalizeEvmTokenId } from "../../shared/evm/token-id.js";
import { BOOTSTRAP_STREAM_CONTENT_TYPE } from "../../shared/bootstrap/operation-output.js";
import { readBootstrapStream } from "../../shared/bootstrap/operation-stream.js";

// Live diagnostics exercise the real API, RPC and resource hosts. These routes
// inspect and measure only: this command never creates a collection or a run.
const { values } = parseArgs({
    options: {
        "backend-origin": { type: "string" },
        "rpc-url": { type: "string" },
        "ipfs-gateway": { type: "string" },
        chain: { type: "string" },
        address: { type: "string" },
        "first-token-id": { type: "string" },
        "token-count": { type: "string" },
        "sample-token-id": { type: "string", multiple: true },
        output: { type: "string" },
        stream: { type: "boolean", default: false },
    },
});
function required(name: keyof typeof values): string {
    const value = values[name];
    if (typeof value !== "string" || !value.trim())
        throw new Error(`--${name} is required`);
    return value;
}
const origin = values["backend-origin"]
    ? new URL(values["backend-origin"]).origin
    : null;
if (origin && (values["rpc-url"] || values["ipfs-gateway"]))
    throw new Error("Choose --backend-origin OR --rpc-url with --ipfs-gateway");
const chain = required("chain");
const address = required("address");
const output = path.resolve(required("output"));
const samples = (values["sample-token-id"] ?? []).map((value) => {
    const tokenId = normalizeEvmTokenId(value);
    if (tokenId === null)
        throw new Error("--sample-token-id must be a decimal uint256");
    return tokenId;
});
if (!samples.length) throw new Error("--sample-token-id is required");
const scope = parseBootstrapScope({
    mode: BOOTSTRAP_ENUMERATION_MODE.ManualRange,
    startTokenId: required("first-token-id"),
    tokenCount: Number(required("token-count")),
});
await mkdir(output, { recursive: true });
const isolatedApp = origin
    ? null
    : await (
          await import("../../backend/src/testing/bootstrap-live-http.js")
      ).createBootstrapLiveHttp({
          rpcUrl: required("rpc-url"),
          ipfsGatewayOrigin: required("ipfs-gateway"),
      });
let token = "";
if (origin) {
    const csrfResponse = await fetch(origin + API_CSRF_ROUTE_PATH);
    if (!csrfResponse.ok)
        throw new Error(`CSRF setup: HTTP ${csrfResponse.status}`);
    ({ token } = (await csrfResponse.json()) as { token: string });
}
const report: unknown[] = [];
let failed = false;

async function request<T>(
    name: string,
    route: string,
    body?: unknown,
): Promise<T> {
    const started = Date.now();
    let response: Response;
    if (isolatedApp) {
        const result = await isolatedApp.inject({
            method: body === undefined ? "GET" : "POST",
            url: route,
            payload: body === undefined ? undefined : JSON.stringify(body),
            headers: {
                "content-type": "application/json",
                ...(values.stream
                    ? { accept: BOOTSTRAP_STREAM_CONTENT_TYPE }
                    : {}),
            },
        });
        response = new Response(result.body, {
            status: result.statusCode,
            headers: { "content-type": String(result.headers["content-type"]) },
        });
    } else if (origin) {
        response = await fetch(origin + route, {
            method: body === undefined ? "GET" : "POST",
            headers: {
                origin,
                "content-type": "application/json",
                ...(values.stream
                    ? { accept: BOOTSTRAP_STREAM_CONTENT_TYPE }
                    : {}),
                cookie: `${API_CSRF_COOKIE_NAME}=${token}`,
                [API_CSRF_HEADER_NAME]: token,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(180_000),
        });
    } else {
        throw new Error("Live HTTP target was not initialized");
    }
    let data: unknown;
    if (
        response.headers
            .get("content-type")
            ?.includes(BOOTSTRAP_STREAM_CONTENT_TYPE)
    ) {
        const text = await response.text();
        await writeFile(path.join(output, `${name}.ndjson`), text);
        data = await readBootstrapStream<T>(
            new Response(text),
            () => undefined,
        );
    } else data = await response.json();
    await writeFile(
        path.join(output, `${name}.json`),
        JSON.stringify(data, null, 2),
    );
    const result = {
        name,
        status: response.status,
        milliseconds: Date.now() - started,
    };
    report.push(result);
    console.log(JSON.stringify(result));
    if (!response.ok)
        throw new Error(
            `${name}: HTTP ${response.status}: ${JSON.stringify(data)}`,
        );
    return data as T;
}

try {
    const discovery = await request<BootstrapContractProbeResponse>(
        "contract",
        buildProbeBootstrapCollectionPath({
            chainRef: chain,
            address,
            standard: COLLECTION_STANDARD.Erc721,
        }),
    );
    for (const sampleTokenId of samples) {
        try {
            const result = await request<BootstrapSampleInspectionResponse>(
                `sample-${sampleTokenId}`,
                buildInspectBootstrapSamplePath(chain),
                {
                    address,
                    scope,
                    requestedTokenId: sampleTokenId,
                    observation: discovery.observation,
                },
            );
            const sample = result.sample;
            const fields = inspectBootstrapMetadata({
                text: sample.tokenUriPayload,
                ipfsGatewayOrigin: result.ipfsGatewayOrigin,
            });
            const summary = {
                sampleTokenId,
                owned: sample.ownership?.exists,
                tokenUri: sample.tokenUri?.startsWith("data:")
                    ? "inline"
                    : sample.tokenUri,
                metadataBytes: sample.tokenUriPayloadBytes,
                failure:
                    sample.ownership?.error ??
                    sample.tokenUriError ??
                    sample.tokenUriPayloadError ??
                    sample.metadataError,
                image: fields.image?.startsWith("data:")
                    ? "inline"
                    : fields.image,
            };
            report.push(summary);
            console.log(JSON.stringify(summary));
            if (summary.failure || !fields.image)
                throw new Error(
                    `Sample ${sampleTokenId} has no usable image metadata`,
                );
            const measurement = await request<Record<string, unknown>>(
                `estimate-${sampleTokenId}`,
                buildEstimateBootstrapImageCachePath(chain),
                {
                    sampleTokenId,
                    sourceImageUrl: fields.image,
                    sourceImageBytes: null,
                    imageCacheMode: IMAGE_CACHE_MODE.CacheOnce,
                    maxDimension: 1080,
                },
            );
            const { sampleCachedImageDataUrl, ...summaryMeasurement } =
                measurement;
            report.push(summaryMeasurement);
            console.log(JSON.stringify(summaryMeasurement));
            if (
                typeof sampleCachedImageDataUrl !== "string" ||
                !sampleCachedImageDataUrl.startsWith("data:image/webp;base64,")
            )
                throw new Error(
                    "Estimate did not return a processed WebP preview",
                );
            await writeFile(
                path.join(output, `cached-${sampleTokenId}.webp`),
                Buffer.from(sampleCachedImageDataUrl.split(",")[1], "base64"),
            );
        } catch (error) {
            failed = true;
            console.error(String(error));
            report.push({ sampleTokenId, error: String(error) });
        }
    }
} finally {
    await isolatedApp?.close();
    await writeFile(
        path.join(output, "report.json"),
        JSON.stringify(
            {
                observedAt: new Date().toISOString(),
                origin,
                ipfsGateway: values["ipfs-gateway"] ?? null,
                chain,
                address,
                scope,
                report,
            },
            null,
            2,
        ),
    );
}
if (failed) process.exitCode = 1;
