import partial from "./fixtures/opensea-partial-collection-offer.json" with { type: "json" };
import cambria from "./fixtures/opensea-cambria-offers.json" with { type: "json" };
import captured from "./fixtures/opensea-ranged-offers.json" with { type: "json" };

// Public order-lookup responses captured on 2026-10-11. Signatures and request
// details are omitted. These snapshots establish REST decoding regressions,
// not current order validity or a numeric-range WebSocket payload shape.
export const capturedOpenSeaRangedOfferFixtures = captured.orders;

// Cambria REST order lookups and an observed numeric trait_offer, captured on
// 2026-10-17. Signatures are omitted; these establish decoding, not validity.
export const capturedOpenSeaCambriaRestOffers = cambria.restOffers;
export const capturedOpenSeaNumericStreamOffer = cambria.streamOffer;

// Public REST observation captured on 2026-10-17; signature omitted.
// The associated pinned chain status was 55/100 filled, with 0.6 WETH balance.
export const capturedOpenSeaPartialCollectionOffer = partial;
