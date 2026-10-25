import { SqliteCollectionDataCleanup } from "@artgod/shared/database/collection-data-cleanup";
export { COLLECTION_PURGE_LATE_SCHEMA_TABLE } from "@artgod/shared/database/collection-data-cleanup";

// The backend and authoritative reorg writer share the collection data owner.
export class SqliteCollectionPurgeRepository extends SqliteCollectionDataCleanup {}
