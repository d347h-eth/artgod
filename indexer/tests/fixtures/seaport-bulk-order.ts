import {
    ORDER_SEAPORT_DATA_SOURCE_KIND,
    ORDER_SOURCE_SCOPE_KIND,
    ORDER_SOURCE_STATUS,
    ORDER_STATUS,
    type OrderRecord,
} from "../../src/domain/orders.js";

// Public OpenSea listing captured on 2026-09-26. This contains no signing key.
// The 163-byte signature was rejected by the former single-order verifier.
const captured = {
    observedAt: 1790419465,
    order: {
        id: "0x4ce76cc50d50f751a90cc1de26fc72bce5f55314ccef73630e30dc7e32e502c1",
        chainId: 1,
        collectionId: 1,
        kind: "seaport",
        side: "sell",
        source: "opensea",
        maker: "0x588115a13c2192ecd555dd7e56dacce137df41bf",
        contract: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
        tokenId: "7881",
        price: "350000000000000000",
        currency: "0x0000000000000000000000000000000000000000",
        validFrom: 1787846494,
        validUntil: 1793030494,
        seaportData: {
            protocolAddress: "0x0000000000000068f116a894984e2db1123eb395",
            signature:
                "0x469b45e8a1b20d4a69973c2d4af53d8e0b87ced370f0bba20558df2820685a1edbbec9d5ea5310472544bc8822e19e8530c0e1f0e253585ea72fb4b908166b050000000e828d8502ccf5afd4533edba57b085fc0fd53003bd44147e836b9006845dfa74c03cfbf66e9fb97b8b981617bfdb0acdf45abce3fe0f2b6f17f857a481d45a2b6d050c7a59f555b44e215724be0fb3a6e79653e1d05af28e2516db9e29b52b1",
            offerer: "0x588115a13c2192ecd555dd7e56dacce137df41bf",
            zone: "0x0000000000000000000000000000000000000000",
            offer: [
                {
                    itemType: "2",
                    token: "0x4e1f41613c9084fdb9e34e11fae9412427480e56",
                    identifierOrCriteria: "7881",
                    startAmount: "1",
                    endAmount: "1",
                },
            ],
            consideration: [
                {
                    itemType: "0",
                    token: "0x0000000000000000000000000000000000000000",
                    identifierOrCriteria: "0",
                    startAmount: "346500000000000000",
                    endAmount: "346500000000000000",
                    recipient: "0x588115a13c2192ecd555dd7e56dacce137df41bf",
                },
                {
                    itemType: "0",
                    token: "0x0000000000000000000000000000000000000000",
                    identifierOrCriteria: "0",
                    startAmount: "3500000000000000",
                    endAmount: "3500000000000000",
                    recipient: "0x0000a26b00c1f0df003000390027140000faa719",
                },
            ],
            orderType: "0",
            startTime: "1787846494",
            endTime: "1793030494",
            zoneHash:
                "0x0000000000000000000000000000000000000000000000000000000000000000",
            salt: "27855337018906766782546881864045825683096516384821792734237756118541991046256",
            conduitKey:
                "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000",
            totalOriginalConsiderationItems: "2",
            counter: "0",
        },
    },
};

export const BULK_ORDER_OBSERVED_AT = captured.observedAt;

export function capturedBulkOrder(): OrderRecord {
    return {
        ...structuredClone(captured.order),
        side: "sell",
        sourceScopeKind: ORDER_SOURCE_SCOPE_KIND.Token,
        sourceStatus: ORDER_SOURCE_STATUS.Active,
        fillabilityStatus: ORDER_STATUS.Invalid,
        seaportDataSourceKind: ORDER_SEAPORT_DATA_SOURCE_KIND.Stream,
    };
}
