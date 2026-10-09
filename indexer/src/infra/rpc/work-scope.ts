import { AsyncLocalStorage } from "node:async_hooks";
import {
    SYNC_WORK_CLASS,
    type SyncWorkClass,
} from "@artgod/shared/types/sync-work-class";

/** Inject this scope into RPC adapters and explicitly enter it at runtime job boundaries.
 * Async isolation prevents concurrent main and gap jobs from changing each other's budget. */
export class RpcWorkScope {
    private readonly storage = new AsyncLocalStorage<SyncWorkClass>();
    current = (): SyncWorkClass =>
        this.storage.getStore() ?? SYNC_WORK_CLASS.Main;

    run<T>(workClass: SyncWorkClass, task: () => T): T {
        return this.storage.run(workClass, task);
    }
}
