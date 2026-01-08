import { logger } from "@artgod/shared/utils";
import type {
    ActivityDomainPort,
    DomainSyncContext,
    MetadataDomainPort,
    OrdersDomainPort,
} from "../../ports/domain-handlers.js";

export class NoopOrdersDomain implements OrdersDomainPort {
    async handleDomainSync(context: DomainSyncContext): Promise<void> {
        logger.debug("Orders domain noop", {
            component: "OrdersDomain",
            action: "handleDomainSync",
            ...context,
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
