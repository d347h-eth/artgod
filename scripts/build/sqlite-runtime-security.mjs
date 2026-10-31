// SQLite 3.53.2 fixes CVE-2026-11822/CVE-2026-11824 in FTS5.
// Check the loaded library, since a patched npm graph alone cannot prove this.
export const MINIMUM_SQLITE_SECURITY_VERSION = "3.53.2";

export function assertSqliteSecurityVersion(version) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
        throw new Error(`Invalid native SQLite version: ${version}`);
    }
    const actual = version.split(".").map(Number);
    const minimum = MINIMUM_SQLITE_SECURITY_VERSION.split(".").map(Number);
    if (!actual.every(Number.isSafeInteger))
        throw new Error(`Invalid native SQLite version: ${version}`);
    for (let index = 0; index < minimum.length; index++) {
        if (actual[index] > minimum[index]) return;
        if (actual[index] < minimum[index]) {
            throw new Error(
                `Native SQLite ${version} predates the FTS5 security fix; require ${MINIMUM_SQLITE_SECURITY_VERSION} or newer.`,
            );
        }
    }
}

export function verifySqliteRuntimeSecurity(Database) {
    const database = new Database(":memory:");
    try {
        const version = database
            .prepare("SELECT sqlite_version() AS version")
            .get()?.version;
        assertSqliteSecurityVersion(version);
        return version;
    } finally {
        database.close();
    }
}
