/** Connection-wide SQLite allocation policy. This does not trigger checkpoints. */
export const SQLITE_STORAGE_POLICY = Object.freeze({
    journalSizeLimitBytes: 64 * 1_024 * 1_024,
});
