import { COLLECTION_TOKEN_SCOPE_KIND } from "@artgod/shared/collections/token-scope";
import { db } from "@artgod/shared/database";
import {
    BOOTSTRAP_ENUMERATION_MODE,
    BOOTSTRAP_METADATA_MODE,
    BOOTSTRAP_RUN_STATUS,
} from "@artgod/shared/bootstrap/pipeline";
import { COLLECTION_STANDARD, COLLECTION_STATUS } from "@artgod/shared/types";

// Storage fixtures still require a real current run, even when exercising only
// one task table. Prior completed runs are failed before replacing that run.
export function seedBootstrapRunFixture(runId: number, collectionId = 7): void {
    if (db.prepare("SELECT 1 FROM bootstrap_runs WHERE run_id=?").get(runId))
        return;
    const contract = `0x${collectionId.toString(16).padStart(40, "0")}`;
    db.prepare(
        "INSERT OR IGNORE INTO collections(collection_id,chain_id,slug,address,standard,status,token_scope_kind) VALUES (?,1,?,?,?,?,?)",
    ).run(
        collectionId,
        `bootstrap-task-${collectionId}`,
        contract,
        COLLECTION_STANDARD.Erc721,
        COLLECTION_STATUS.Bootstrapping,
        COLLECTION_TOKEN_SCOPE_KIND.AllContractTokens,
    );
    db.prepare(
        "UPDATE bootstrap_runs SET status=? WHERE chain_id=1 AND collection_id=?",
    ).run(BOOTSTRAP_RUN_STATUS.Failed, collectionId);
    db.prepare(
        "INSERT INTO bootstrap_runs(run_id,chain_id,collection_id,request_slug,request_address,request_standard,metadata_mode,enumeration_mode,status) VALUES (?,1,?,?,?,?,?,?,?)",
    ).run(
        runId,
        collectionId,
        `bootstrap-task-${collectionId}`,
        contract,
        COLLECTION_STANDARD.Erc721,
        BOOTSTRAP_METADATA_MODE.Strict,
        BOOTSTRAP_ENUMERATION_MODE.ManualTokenIds,
        BOOTSTRAP_RUN_STATUS.Metadata,
    );
}
