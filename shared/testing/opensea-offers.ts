import captured from "./fixtures/opensea-ranged-offers.json" with { type: "json" };

// Public order-lookup responses captured on 2026-10-11. Signatures and request
// details are omitted. These snapshots establish REST decoding regressions,
// not current order validity or a numeric-range WebSocket payload shape.
export const capturedOpenSeaRangedOfferFixtures = captured.orders;
