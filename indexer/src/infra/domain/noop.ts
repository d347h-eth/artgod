import { logger } from "@artgod/shared/utils";
import type {
    ActivityDomainPort,
    DomainSyncContext,
    MetadataDomainPort,
    OrdersDomainPort,
} from "../../ports/domain-handlers.js";
import type {
    OrderUpdateByIdPayload,
    OrderUpdateByMakerPayload,
} from "../../domain/order-jobs.js";

export class NoopOrdersDomain implements OrdersDomainPort {
    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        logger.debug("Orders domain noop", {
            component: "OrdersDomain",
            action: "handleDomainSync",
            ...context,
        });
    }

    async handleOrderUpdateByMaker(
        payload: OrderUpdateByMakerPayload,
    ): Promise<void> {
        logger.debug("Orders update-by-maker noop", {
            component: "OrdersDomain",
            action: "handleOrderUpdateByMaker",
            ...payload,
        });
    }

    async handleOrderUpdateById(
        payload: OrderUpdateByIdPayload,
    ): Promise<void> {
        logger.debug("Orders update-by-id noop", {
            component: "OrdersDomain",
            action: "handleOrderUpdateById",
            ...payload,
        });
    }
}

export class NoopMetadataDomain implements MetadataDomainPort {
    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        logger.debug("Metadata domain noop", {
            component: "MetadataDomain",
            action: "handleDomainSync",
            ...context,
        });
    }
}

export class NoopActivityDomain implements ActivityDomainPort {
    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        logger.debug("Activity domain noop", {
            component: "ActivityDomain",
            action: "handleDomainSync",
            ...context,
        });
    }
}
