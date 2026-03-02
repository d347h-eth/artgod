import { db } from "@artgod/shared/database";
import type { RuntimeHealthDatabasePort } from "../../application/use-cases/health/get-runtime-health.js";

export class SqliteRuntimeHealthAdapter implements RuntimeHealthDatabasePort {
    pingDatabase(): void {
        db.prepare("SELECT 1").get();
    }
}
