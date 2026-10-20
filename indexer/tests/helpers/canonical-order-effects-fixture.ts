import { RetainCanonicalOrderEffects } from "../../src/application/orders/retain-canonical-order-effects.js";
import { SqliteOrdersDomain } from "../../src/infra/domain/orders.js";
import { SqliteMakerRevalidations } from "../../src/infra/orders/sqlite-maker-revalidations.js";
import { SqliteOrderValidationDemand } from "../../src/infra/orders/sqlite-order-validation-demand.js";

/** Real critical-effect retention for writer tests; no fixture may silently
 * discard an order invalidation or make an unexpected validation RPC. */
export function createCanonicalOrderEffectsFixture(wethAddress: string) {
    const orders = new SqliteOrdersDomain(wethAddress);
    const validation = new SqliteOrderValidationDemand(orders);
    const makers = new SqliteMakerRevalidations(
        orders,
        validation,
        wethAddress,
    );
    return new RetainCanonicalOrderEffects({ orders, makers });
}
