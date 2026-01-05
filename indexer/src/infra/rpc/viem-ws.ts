import { createPublicClient, webSocket } from "viem";
import type { HeadSourcePort } from "../../ports/head-source.js";

export class ViemWebSocketHeadSource implements HeadSourcePort {
    private client: ReturnType<typeof createPublicClient>;

    constructor(private url: string) {
        this.client = createPublicClient({
            transport: webSocket(this.url),
        });
    }

    async start(
        onHead: (head: number) => void,
        onError?: (error: unknown) => void,
    ): Promise<() => Promise<void>> {
        const unwatch = this.client.watchBlockNumber({
            emitOnBegin: false,
            onBlockNumber: (blockNumber) => {
                onHead(toSafeNumber(blockNumber, "blockNumber"));
            },
            onError: (error) => {
                if (onError) onError(error);
            },
        });

        return async () => {
            unwatch();
        };
    }
}

function toSafeNumber(value: bigint, label: string): number {
    const num = Number(value);
    if (!Number.isSafeInteger(num)) {
        throw new Error(`${label} exceeds JS safe integer: ${String(value)}`);
    }
    return num;
}
