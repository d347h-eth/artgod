use super::bot_runtime::BOT_RUNTIME_SPECS;

/// Desktop backend child-process name used for supervision and app-data logs.
pub(crate) const BACKEND_PROCESS_NAME: &str = "backend";
/// Bundled backend runtime artifact relative to the desktop runtime resource dir.
pub(crate) const BACKEND_ARTIFACT: &str = "backend/dist-desktop/server.mjs";
/// Local NATS child-process name used for supervision and app-data logs.
pub(crate) const NATS_PROCESS_NAME: &str = "nats";
/// Supervisor-owned log process name for desktop runtime lifecycle messages.
pub(crate) const SUPERVISOR_PROCESS_NAME: &str = "desktop-supervisor";

/// Desktop-managed indexer workers and their bundled runtime artifacts.
pub(crate) const INDEXER_WORKERS: &[(&str, &str)] = &[
    (
        "indexer-scheduler-worker",
        "indexer/dist-desktop/scheduler-worker.mjs",
    ),
    (
        "indexer-sync-worker",
        "indexer/dist-desktop/sync-worker.mjs",
    ),
    (
        "indexer-reorg-worker",
        "indexer/dist-desktop/reorg-worker.mjs",
    ),
    (
        "indexer-domain-worker",
        "indexer/dist-desktop/domain-worker.mjs",
    ),
    (
        "indexer-offchain-ingest-worker",
        "indexer/dist-desktop/offchain-ingest-worker.mjs",
    ),
    (
        "indexer-opensea-stream-worker",
        "indexer/dist-desktop/opensea-stream-worker.mjs",
    ),
    (
        "indexer-opensea-bootstrap-worker",
        "indexer/dist-desktop/opensea-bootstrap-worker.mjs",
    ),
    (
        "indexer-opensea-reconcile-worker",
        "indexer/dist-desktop/opensea-reconcile-worker.mjs",
    ),
    (
        "indexer-opensea-reconcile-scheduler-worker",
        "indexer/dist-desktop/opensea-reconcile-scheduler-worker.mjs",
    ),
    (
        "indexer-bootstrap-worker",
        "indexer/dist-desktop/bootstrap-worker.mjs",
    ),
    (
        "indexer-collection-extension-worker",
        "indexer/dist-desktop/collection-extension-worker.mjs",
    ),
    (
        "indexer-dead-letter-worker",
        "indexer/dist-desktop/dead-letter-worker.mjs",
    ),
];

/// Returns every desktop runtime process name that should have an app-data log file.
pub(crate) fn runtime_log_process_names() -> Vec<&'static str> {
    let mut names = Vec::with_capacity(3 + INDEXER_WORKERS.len() + BOT_RUNTIME_SPECS.len());
    names.push(SUPERVISOR_PROCESS_NAME);
    names.push(NATS_PROCESS_NAME);
    names.push(BACKEND_PROCESS_NAME);
    names.extend(
        INDEXER_WORKERS
            .iter()
            .map(|(process_name, _)| *process_name),
    );
    names.extend(BOT_RUNTIME_SPECS.iter().map(|spec| spec.process_name));
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_log_process_names_include_core_indexer_and_bot_runtimes() {
        let names = runtime_log_process_names();

        assert!(names.contains(&SUPERVISOR_PROCESS_NAME));
        assert!(names.contains(&NATS_PROCESS_NAME));
        assert!(names.contains(&BACKEND_PROCESS_NAME));
        assert!(names.contains(&"indexer-sync-worker"));
        assert!(names.contains(&"trading-bidding-bot"));
        assert!(names.contains(&"trading-sniping-bot"));
    }
}
