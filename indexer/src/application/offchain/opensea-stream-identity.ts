import { createHash, randomUUID } from "node:crypto";
import { OFFCHAIN_OBSERVATION_CHANNEL } from "../../domain/offchain-jobs.js";
import {
    getOpenSeaEventType,
    getOpenSeaOrderId,
    getOpenSeaSourceEventAt,
    getOpenSeaEventIdentifiers,
    OPENSEA_STREAM_EVENT_TYPE,
} from "@artgod/shared/opensea/payload";

export function getOpenSeaStreamDedupeKey(
    raw: unknown,
    receivedAt: number,
): string {
    const eventType = getOpenSeaEventType(raw);
    let identity = getOpenSeaOrderId(raw) ?? "na";
    if (eventType === OPENSEA_STREAM_EVENT_TYPE.ItemSold) {
        const sale = getOpenSeaEventIdentifiers(raw);
        if (!sale.orderId) {
            // Distinct tokens/transactions must not share the old `na` key in
            // the same second. Identical token hints can safely coalesce.
            identity =
                sale.maker && sale.contract && sale.tokenId !== null
                    ? createHash("sha256")
                          .update(
                              JSON.stringify([
                                  sale.nftChain,
                                  sale.contract,
                                  sale.tokenId,
                                  sale.maker,
                                  sale.transactionHash,
                              ]),
                          )
                          .digest("hex")
                    : // Preserve malformed events for diagnosis even without an identity.
                      randomUUID();
        }
    }
    return `${OFFCHAIN_OBSERVATION_CHANNEL.Stream}:${eventType}:${identity}:${getOpenSeaSourceEventAt(raw) ?? receivedAt}`;
}
