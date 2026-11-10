import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { validateScenario, SCENARIO_KIND } from "./scenario-contract.mjs";
import { QUALIFICATION_CHECKS } from "../qualification-protocol.mjs";
import {
    NATIVE_DIAGNOSTIC_PROFILE,
    NATIVE_DIAGNOSTIC_CHECK,
} from "./native-failure-evidence.mjs";

test("native capture has a separate explicit probe while the default eight-check M0 remains unchanged", async () => {
    const qualification = JSON.parse(
        await readFile(
            new URL("../scenarios/qualification.json", import.meta.url),
            "utf8",
        ),
    );
    assert.deepEqual(
        validateScenario(qualification).expectedChecks,
        QUALIFICATION_CHECKS,
    );
    assert.equal(qualification.nativeDiagnostics, undefined);
    const probe = {
        version: 1,
        kind: SCENARIO_KIND.NativeDiagnostic,
        qualificationId: "native-core-probe-test",
        expectedChecks: [NATIVE_DIAGNOSTIC_CHECK],
        nativeDiagnostics: { profile: NATIVE_DIAGNOSTIC_PROFILE.BoundedCore },
    };
    assert.deepEqual(validateScenario(probe), probe);
    assert.throws(
        () => validateScenario({ ...probe, nativeDiagnostics: undefined }),
        /explicit profile/,
    );
    assert.throws(
        () =>
            validateScenario({
                ...qualification,
                nativeDiagnostics: probe.nativeDiagnostics,
            }),
        /explicit probe/,
    );
    assert.throws(
        () =>
            validateScenario({
                ...probe,
                nativeDiagnostics: { ...probe.nativeDiagnostics, bytes: 0 },
            }),
        /exactly/,
    );
    assert.throws(
        () =>
            validateScenario({
                ...probe,
                expectedChecks: QUALIFICATION_CHECKS,
            }),
        /every check/,
    );
});
