import assert from "node:assert/strict";
import test from "node:test";
import { assertSqliteSecurityVersion } from "./sqlite-runtime-security.mjs";

test("native SQLite admission rejects pre-fix libraries and accepts later branches", () => {
    for (const version of ["3.53.2", "3.53.3", "3.54.1", "4.0.0"]) {
        assert.doesNotThrow(() => assertSqliteSecurityVersion(version));
    }
    for (const version of ["3.53.1", "3.52.9", "2.99.9"]) {
        assert.throws(
            () => assertSqliteSecurityVersion(version),
            /predates the FTS5 security fix/,
        );
    }
    for (const version of [undefined, "", "3.53", "3.53.2-unknown"]) {
        assert.throws(
            () => assertSqliteSecurityVersion(version),
            /Invalid native SQLite version/,
        );
    }
});
