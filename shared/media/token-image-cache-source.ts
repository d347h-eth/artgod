import { Buffer } from "node:buffer";
import {
    fetchWithHttpResilience,
    type HttpFetchResilienceConfig,
} from "../network/http-fetch-resilience.js";
import {
    parseImageDataUriBuffer,
    resolveTokenResourceUri,
} from "./token-resource-uri.js";

export type TokenImageCacheSourcePayload = {
    buffer: Buffer;
    contentType: string | null;
};

export async function fetchTokenImageCacheSource(input: {
    sourceImageUrl: string;
    ipfsGatewayOrigin: string;
    maxSourceBytes: number;
    fetchResilience: HttpFetchResilienceConfig;
}): Promise<TokenImageCacheSourcePayload> {
    const resolved = resolveTokenResourceUri(input.sourceImageUrl, {
        ipfsGatewayOrigin: input.ipfsGatewayOrigin,
    });
    if (!resolved) {
        throw new Error("Unsupported image URI");
    }

    if (resolved.startsWith("data:")) {
        const data = parseImageDataUriBuffer(resolved);
        assertSourceLimit(data.buffer.byteLength, input.maxSourceBytes);
        return {
            buffer: data.buffer,
            contentType: data.contentType,
        };
    }

    if (!/^https?:\/\//i.test(resolved)) {
        throw new Error("Unsupported image URI");
    }

    const response = await fetchWithHttpResilience({
        input: resolved,
        config: input.fetchResilience,
        init: {
            headers: { accept: "image/*,*/*;q=0.1" },
        },
    });
    if (!response.ok) {
        throw new Error(`Image fetch failed: HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (
        Number.isFinite(contentLength) &&
        contentLength > input.maxSourceBytes
    ) {
        throw new Error(
            `Image payload exceeds ${input.maxSourceBytes} bytes`,
        );
    }

    return {
        buffer: await readResponseBufferWithLimit(
            response,
            input.maxSourceBytes,
        ),
        contentType: normalizeImageContentType(
            response.headers.get("content-type"),
        ),
    };
}

export function normalizeImageContentType(value: string | null): string | null {
    const normalized = value?.split(";")[0]?.trim().toLowerCase() ?? "";
    return normalized || null;
}

async function readResponseBufferWithLimit(
    response: Response,
    maxBytes: number,
): Promise<Buffer> {
    const body = response.body;
    if (!body) {
        const buffer = Buffer.from(await response.arrayBuffer());
        assertSourceLimit(buffer.byteLength, maxBytes);
        return buffer;
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        assertSourceLimit(received, maxBytes);
        chunks.push(value);
    }
    return Buffer.concat(chunks, received);
}

function assertSourceLimit(bytes: number, maxBytes: number): void {
    if (bytes > maxBytes) {
        throw new Error(`Image payload exceeds ${maxBytes} bytes`);
    }
}
