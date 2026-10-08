import { http, type HttpTransport } from "viem";
import {
    type RpcEndpointResilienceConfig,
    VIEM_TRANSPORT_RETRY_DISABLED,
} from "./rpc-resilience.js";

// Keeps viem HTTP limits aligned with adapter retries and releases rejected bodies.
export function createHttpRpcTransport(
    url: string,
    config: Pick<
        RpcEndpointResilienceConfig,
        "requestTimeoutMs" | "maxResponseBodySizeBytes"
    >,
): HttpTransport {
    const { requestTimeoutMs, maxResponseBodySizeBytes } = config;
    return http(url, {
        timeout: requestTimeoutMs,
        maxResponseBodySize: maxResponseBodySizeBytes,
        retryCount: VIEM_TRANSPORT_RETRY_DISABLED,
        onFetchResponse: async (response) => {
            const declaredSize = Number(response.headers.get("Content-Length"));
            // viem 2.54.6 rejects this header before reading or cancelling its body.
            // Use its response hook to release it; viem still owns the typed size
            // error and streamed-byte limit. Cleanup failure must not mask that error.
            if (declaredSize > maxResponseBodySizeBytes) {
                await response.body?.cancel().catch(() => undefined);
            }
        },
    });
}
