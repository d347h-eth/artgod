import {
    type GetCollectionDetailInput,
    type GetCollectionDetailOutput,
    type GetCollectionDetailPort,
} from "./get-collection-detail.js";
import { isCollectionDetailDefaultQueryCacheEligible } from "./cached-get-collection-detail.js";
import type { TokenPreviewWarmupPort } from "./cached-get-token-preview.js";

type MaybePromise<T> = T | Promise<T>;

export class WarmingGetCollectionDetail implements GetCollectionDetailPort {
    constructor(
        private readonly inner: GetCollectionDetailPort,
        private readonly tokenPreviewWarmupPort: TokenPreviewWarmupPort,
    ) {}

    getCollectionDetail(
        input: GetCollectionDetailInput,
    ): MaybePromise<GetCollectionDetailOutput> {
        const result = this.inner.getCollectionDetail(input);
        if (isPromiseLike(result)) {
            return result.then((output) =>
                this.scheduleWarmupIfEligible(input, output),
            );
        }
        return this.scheduleWarmupIfEligible(input, result);
    }

    private scheduleWarmupIfEligible(
        input: GetCollectionDetailInput,
        output: GetCollectionDetailOutput,
    ): GetCollectionDetailOutput {
        if (!isCollectionDetailDefaultQueryCacheEligible(input)) {
            return output;
        }
        this.tokenPreviewWarmupPort.warmTokenPreviews({
            chainRef: input.chainRef,
            collectionRef: input.collectionRef,
            mediaMode: output.media.defaultMode,
            tokenRefs: output.tokens.items.map((token) => token.tokenId),
        });
        return output;
    }
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
    return (
        typeof value === "object" &&
        value !== null &&
        "then" in value &&
        typeof value.then === "function"
    );
}
