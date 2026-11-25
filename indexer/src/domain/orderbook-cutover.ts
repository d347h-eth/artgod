import { DOMAIN_JOB_KIND } from "./domain-jobs.js";
import { ORDER_JOB_KIND } from "./order-jobs.js";
import { OPENSEA_JOB_KIND } from "./opensea-jobs.js";
import { QUEUE_NAMES } from "./queues.js";

/** Historical wire subjects must remain recognizable until an installation
 * retires its pre-multi-book jobs. Raw offchain traffic also carries metadata
 * and activities and must finish dispatching before the cutover. */
export const LEGACY_BOOK_JOBS: ReadonlyMap<string, readonly string[]> = new Map<
    string,
    readonly string[]
>([
    ["opensea-bootstrap", [OPENSEA_JOB_KIND.BootstrapCollection]],
    ["opensea-reconcile", [OPENSEA_JOB_KIND.ReconcileCollection]],
    [QUEUE_NAMES.OrdersUpsert, [ORDER_JOB_KIND.Upsert]],
    [
        QUEUE_NAMES.OrdersDomain,
        [DOMAIN_JOB_KIND.OrdersSync, ...Object.values(ORDER_JOB_KIND)],
    ],
    [QUEUE_NAMES.OrdersUpdateByMaker, [ORDER_JOB_KIND.UpdateByMaker]],
    [QUEUE_NAMES.OrdersUpdateByToken, [ORDER_JOB_KIND.UpdateByMaker]],
    [QUEUE_NAMES.OrdersUpdateById, [ORDER_JOB_KIND.UpdateById]],
    [QUEUE_NAMES.OrderLifecycle, [ORDER_JOB_KIND.UpdateById]],
]);
